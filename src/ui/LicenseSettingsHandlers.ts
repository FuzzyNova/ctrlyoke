import { LICENSE_ACTIONS, MESSAGE_TYPES } from "../types/DashboardConstants";
import {
  LicenseActivationLimitError,
  type Entitlement,
  type LicenseMachineSummary,
} from "../license/LicenseService";
import type {
  ActivateLicenseKeyMessage,
  DeactivateLicenseMachineMessage,
  ImportLicenseFileMessage,
  LicenseActionResultMessage,
  LicenseMachinesUpdatedMessage,
} from "../types/WebviewMessageTypes";
import { getErrorMessage } from "../utils/ErrorUtils";
import type { WebviewClientContext } from "./WebviewClientContext";

/** The license-service surface needed by dashboard license actions. */
export interface LicenseActionService {
  getStoredLicenseKey(): Promise<string | undefined>;
  activateWithKey(key: string): Promise<Entitlement>;
  importLicenseFile(blob: string): Promise<Entitlement>;
  deactivate(): Promise<void>;
  listMachines(key: string): Promise<LicenseMachineSummary[]>;
  deactivateMachine(key: string, machineId: string): Promise<void>;
}

/** Handles dashboard license actions and keeps their replies client-scoped. */
export class LicenseSettingsHandlers {
  constructor(private readonly licenseService?: LicenseActionService) {}

  async handleActivateLicenseKey(
    message: ActivateLicenseKeyMessage,
    ctx: WebviewClientContext
  ): Promise<void> {
    await this.runAction(
      ctx,
      MESSAGE_TYPES.ACTIVATE_LICENSE_KEY,
      () => this.requireService().activateWithKey(message.key),
      "License activated successfully."
    );
  }

  async handleImportLicenseFile(
    message: ImportLicenseFileMessage,
    ctx: WebviewClientContext
  ): Promise<void> {
    await this.runAction(
      ctx,
      MESSAGE_TYPES.IMPORT_LICENSE_FILE,
      () => this.requireService().importLicenseFile(message.blob),
      "License file imported successfully."
    );
  }

  async handleDeactivateLicense(ctx: WebviewClientContext): Promise<void> {
    await this.runAction(
      ctx,
      MESSAGE_TYPES.DEACTIVATE_LICENSE,
      () => this.requireService().deactivate(),
      "License deactivated successfully."
    );
  }

  async handleRequestLicenseMachines(ctx: WebviewClientContext): Promise<void> {
    const action = MESSAGE_TYPES.REQUEST_LICENSE_MACHINES;
    try {
      const machines = await this.listStoredLicenseMachines();
      this.sendMachines(ctx, machines);
      this.sendSuccess(ctx, action, "License machines loaded.");
    } catch (error) {
      this.sendError(ctx, action, error);
    }
  }

  async handleDeactivateLicenseMachine(
    message: DeactivateLicenseMachineMessage,
    ctx: WebviewClientContext
  ): Promise<void> {
    const action = MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE;
    try {
      const service = this.requireService();
      const key = await this.requireStoredLicenseKey();
      await service.deactivateMachine(key, message.machineId);
      this.sendMachines(ctx, await service.listMachines(key));
      this.sendSuccess(
        ctx,
        action,
        "License machine deactivated successfully."
      );
    } catch (error) {
      this.sendError(ctx, action, error);
    }
  }

  private async runAction<T>(
    ctx: WebviewClientContext,
    action: string,
    operation: () => Promise<T>,
    successMessage: string
  ): Promise<void> {
    try {
      await operation();
      this.sendSuccess(ctx, action, successMessage);
    } catch (error) {
      this.sendError(ctx, action, error);
    }
  }

  private async listStoredLicenseMachines(): Promise<LicenseMachineSummary[]> {
    const service = this.requireService();
    return service.listMachines(await this.requireStoredLicenseKey());
  }

  private async requireStoredLicenseKey(): Promise<string> {
    const key = await this.requireService().getStoredLicenseKey();
    if (!key) {
      throw new Error("No online Pro license key is stored on this machine.");
    }
    return key;
  }

  private requireService(): LicenseActionService {
    if (!this.licenseService) {
      throw new Error("The license service is unavailable.");
    }
    return this.licenseService;
  }

  private sendMachines(
    ctx: WebviewClientContext,
    machines: LicenseMachineSummary[]
  ): void {
    const message: LicenseMachinesUpdatedMessage = {
      type: MESSAGE_TYPES.LICENSE_MACHINES_UPDATED,
      machines,
    };
    ctx.postMessage(message);
  }

  private sendSuccess(
    ctx: WebviewClientContext,
    action: string,
    message: string
  ): void {
    this.sendResult(ctx, { action, status: "success", message });
  }

  private sendError(
    ctx: WebviewClientContext,
    action: string,
    error: unknown
  ): void {
    this.sendResult(ctx, {
      action:
        error instanceof LicenseActivationLimitError
          ? LICENSE_ACTIONS.ACTIVATION_LIMIT
          : action,
      status: "error",
      message: getErrorMessage(error),
    });
  }

  private sendResult(
    ctx: WebviewClientContext,
    result: Omit<LicenseActionResultMessage, "type">
  ): void {
    ctx.postMessage({ type: MESSAGE_TYPES.LICENSE_ACTION_RESULT, ...result });
  }
}
