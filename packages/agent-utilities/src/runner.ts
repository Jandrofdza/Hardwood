import type { AgentEngine, BillerConnector, ExecuteOutcome, Run } from "@hardwood/agents-core";
import { HardwoodError } from "@hardwood/agents-core";
import type { BillerId } from "./billers.js";
import { billTargetSchema, utilitiesAgent } from "./manifest.js";

/** Where the runner finds a connector for each biller (mock today, other modes later). */
export interface ConnectorRegistry {
  get(billerId: BillerId): BillerConnector | undefined;
}

export const connectorRegistry = (connectors: BillerConnector[]): ConnectorRegistry => {
  const byId = new Map(connectors.map((c) => [c.billerId, c]));
  return { get: (id) => byId.get(id) };
};

/**
 * Deterministic driver for the Utilities Agent's runs. It looks bills up and asks for
 * approval; paying goes through `AgentEngine.execute`, which refuses unapproved runs.
 */
export class UtilitiesRunner {
  constructor(
    private readonly engine: AgentEngine,
    private readonly connectors: ConnectorRegistry,
  ) {}

  /**
   * Take a queued run as far as it goes without a human: a finished lookup, a payment
   * waiting for approval, or a failure.
   */
  async process(runId: string): Promise<Run> {
    const { run } = await this.engine.getRun(runId);
    if (run.agentId !== utilitiesAgent.id) {
      throw new HardwoodError("invalid_input", `run ${runId} is not a ${utilitiesAgent.id} run`);
    }
    const target = billTargetSchema.parse(run.input);
    const connector = this.connector(target.billerId);
    await this.engine.startRun(runId);

    if (!connector.validateAccountRef(target.accountRef)) {
      return this.fail(
        runId,
        "invalid_account_ref",
        "the biller does not accept this account reference",
      );
    }
    let bill;
    try {
      bill = await connector.lookup(target.accountRef);
    } catch {
      // Connector errors can carry portal details; keep them out of run history.
      return this.fail(runId, "lookup_failed", "could not reach the biller");
    }
    if (!bill) return this.fail(runId, "no_open_bill", "there is no open bill for this account");
    if (bill.billerId !== target.billerId || bill.accountRef !== target.accountRef) {
      return this.fail(
        runId,
        "connector_mismatch",
        "the biller returned a different account's bill",
      );
    }
    if (target.period && bill.period !== target.period) {
      return this.fail(
        runId,
        "period_mismatch",
        `the open bill is for ${bill.period}, not ${target.period}`,
      );
    }

    return run.action === "lookup_bill"
      ? this.engine.completeRun(runId, { bill })
      : this.engine.proposePayment(runId, bill);
  }

  /** Pay an approved run. */
  async execute(runId: string): Promise<ExecuteOutcome> {
    return this.engine.execute(runId, await this.connectorForRun(runId));
  }

  /** Settle a payment whose outcome was unknown. */
  async reconcile(runId: string): Promise<ExecuteOutcome> {
    return this.engine.reconcile(runId, await this.connectorForRun(runId));
  }

  /** Re-check a bill waiting for approval; a new amount needs a new approval. */
  async refresh(runId: string): Promise<Run> {
    return this.engine.refreshProposal(runId, await this.connectorForRun(runId));
  }

  private fail(runId: string, code: string, message: string) {
    return this.engine.failRun(runId, { code, message });
  }

  private async connectorForRun(runId: string) {
    const { run } = await this.engine.getRun(runId);
    const billerId = run.proposal?.billerId;
    if (!billerId) throw new HardwoodError("invalid_transition", "run has no bill to pay");
    return this.connector(billerId as BillerId);
  }

  private connector(billerId: BillerId): BillerConnector {
    const c = this.connectors.get(billerId);
    if (!c) throw new HardwoodError("unsupported", `no connector configured for ${billerId}`);
    return c;
  }
}
