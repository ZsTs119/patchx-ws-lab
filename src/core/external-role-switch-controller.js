const ROLE_CODES = new Set(["01", "02", "03", "04", "05", "06"]);
const BUSY_STATES = new Set(["preparing", "disconnecting", "connecting", "awaiting_hello"]);

class ControllerOperationCancelled extends Error {
  constructor() {
    super("External role switch operation cancelled");
    this.name = "ControllerOperationCancelled";
  }
}

export function isRuntimeOwnerCurrent(expected, current) {
  if (!expected || !current) return false;
  return Number(expected.runtimeEpoch) === Number(current.runtimeEpoch)
    && String(expected.accountKey || "") === String(current.accountKey || "")
    && String(expected.profileKey || "") === String(current.profileKey || "");
}

export function createExternalRoleSwitchController(dependencies) {
  return new ExternalRoleSwitchController(dependencies);
}

class ExternalRoleSwitchController {
  constructor(dependencies = {}) {
    this.dependencies = dependencies;
    this.operationId = 0;
    this.activeOperation = null;
    this.currentRecord = null;
    this.state = {
      status: "idle",
      accountKey: "",
      recordId: "",
      selectedRole: "01",
      attemptId: 0,
      committed: false,
      storageWarning: "",
      error: "",
      message: ""
    };
  }

  async switchTo(nextRole) {
    const context = this.getExternalContext();
    if (!context || !ROLE_CODES.has(String(nextRole || ""))) {
      return { ok: false, error: "外部账号或角色无效" };
    }
    if (BUSY_STATES.has(this.state.status)) {
      return { ok: false, busy: true, error: "角色切换正在进行" };
    }

    const currentRecord = this.getCurrentRecord();
    const currentIdentity = currentRecord?.identity || this.dependencies.getIdentity?.() || null;
    const currentRole = String(currentRecord?.selectedRole || currentIdentity?.roleCode || "01");
    if (currentRole === nextRole) {
      return { ok: true, noop: true };
    }

    const operation = this.createOperation(context.accountKey, false);
    this.updateState({
      status: "preparing",
      accountKey: context.accountKey,
      selectedRole: currentRole,
      attemptId: 0,
      committed: false,
      storageWarning: "",
      error: "",
      message: `正在准备角色 ${nextRole}`
    });

    let candidate;
    try {
      candidate = await this.dependencies.createFreshIdentity(nextRole, currentIdentity);
      this.assertOperation(operation);
    } catch (error) {
      if (!this.isOperationCurrent(operation)) return { ok: false, cancelled: true };
      this.activeOperation = null;
      this.updateState({ status: "error", error: error.message, message: "新身份生成失败" });
      return { ok: false, error };
    }

    try {
      this.dependencies.cancelAutoConnect?.();
      this.updateState({ status: "disconnecting", message: "正在结束旧会话" });
      await this.dependencies.resetRuntime?.("role_switch");
      this.assertOperation(operation);

      this.dependencies.applyIdentity?.({
        accountKey: context.accountKey,
        selectedRole: nextRole,
        identity: candidate
      });
      const saved = await this.dependencies.persist(context.accountKey, nextRole, candidate);
      this.assertOperation(operation);
      if (!saved?.record) throw new Error("角色身份保存结果缺少 record");

      operation.committed = true;
      this.currentRecord = saved.record;
      this.updateState({
        accountKey: context.accountKey,
        recordId: saved.record.recordId,
        selectedRole: saved.record.selectedRole,
        committed: true,
        storageWarning: saved.warning || "",
        error: "",
        message: saved.persisted === false ? "新角色已生效，但浏览器未保存" : "新角色身份已保存"
      });
      return await this.connectRecord(operation, saved.record);
    } catch (error) {
      if (!this.isOperationCurrent(operation) || error instanceof ControllerOperationCancelled) {
        return { ok: false, cancelled: true };
      }
      this.activeOperation = null;
      this.updateState({
        status: operation.committed ? "reconnect_error" : "error",
        error: error.message,
        message: operation.committed ? "连接失败，可重试" : "角色切换失败"
      });
      return { ok: false, error, record: this.currentRecord };
    }
  }

  async retryCurrentIdentity() {
    const context = this.getExternalContext();
    const record = this.getCurrentRecord();
    if (!context || !record?.identity || record.accountKey !== context.accountKey) {
      return { ok: false, error: "当前外部角色身份不可用" };
    }
    if (BUSY_STATES.has(this.state.status)) {
      return { ok: false, busy: true, error: "角色切换正在进行" };
    }

    const operation = this.createOperation(context.accountKey, true);
    this.currentRecord = record;
    this.dependencies.cancelAutoConnect?.();
    this.updateState({
      status: "disconnecting",
      accountKey: context.accountKey,
      recordId: record.recordId,
      selectedRole: record.selectedRole,
      attemptId: 0,
      committed: true,
      storageWarning: this.state.storageWarning,
      error: "",
      message: "正在重新连接当前角色"
    });

    try {
      await this.dependencies.resetRuntime?.("role_retry");
      this.assertOperation(operation);
      return await this.connectRecord(operation, record);
    } catch (error) {
      if (!this.isOperationCurrent(operation) || error instanceof ControllerOperationCancelled) {
        return { ok: false, cancelled: true };
      }
      this.activeOperation = null;
      this.updateState({ status: "reconnect_error", error: error.message, message: "连接失败，可重试" });
      return { ok: false, error, record };
    }
  }

  cancel(reason = "user_cancel") {
    const operation = this.activeOperation;
    const committed = Boolean(operation?.committed || this.state.committed);
    const attemptId = operation?.attemptId || this.state.attemptId;
    this.operationId += 1;
    this.activeOperation = null;
    if (attemptId) this.dependencies.disconnectAttempt?.(attemptId, reason);
    this.updateState({
      status: committed ? "cancelled_disconnected" : "idle",
      attemptId: 0,
      committed,
      error: "",
      message: committed ? "已取消重连，可使用当前角色重新连接" : "已取消角色切换"
    });
    return { cancelled: true, committed };
  }

  invalidate(reason = "invalidated") {
    const attemptId = this.activeOperation?.attemptId || this.state.attemptId;
    this.operationId += 1;
    this.activeOperation = null;
    this.dependencies.cancelAutoConnect?.();
    if (attemptId) this.dependencies.disconnectAttempt?.(attemptId, reason);
    this.updateState({
      status: "idle",
      attemptId: 0,
      committed: false,
      storageWarning: "",
      error: "",
      message: ""
    });
    return { invalidated: true };
  }

  adoptExternalRecord(record) {
    const current = this.getCurrentRecord();
    if (current?.recordId && current.recordId === record?.recordId) {
      return { adopted: false, noop: true };
    }
    if (!record?.recordId || !record?.identity || !ROLE_CODES.has(String(record.selectedRole || ""))) {
      return { adopted: false, error: "外部角色记录无效" };
    }

    const attemptId = this.activeOperation?.attemptId || this.state.attemptId;
    this.operationId += 1;
    this.activeOperation = null;
    this.dependencies.cancelAutoConnect?.();
    if (attemptId) this.dependencies.disconnectAttempt?.(attemptId, "storage_sync");
    this.dependencies.resetRuntime?.("external_role_storage_sync");
    this.currentRecord = record;
    this.dependencies.applyIdentity?.(record);
    this.updateState({
      status: "cancelled_disconnected",
      accountKey: record.accountKey,
      recordId: record.recordId,
      selectedRole: record.selectedRole,
      attemptId: 0,
      committed: true,
      storageWarning: "",
      error: "",
      message: "角色已在其他标签页切换，请重新连接"
    });
    return { adopted: true, record };
  }

  snapshot() {
    const record = this.getCurrentRecord();
    return Object.freeze({
      ...this.state,
      operationId: this.operationId,
      accountKey: this.state.accountKey || record?.accountKey || "",
      recordId: this.state.recordId || record?.recordId || "",
      selectedRole: this.state.selectedRole || record?.selectedRole || "01",
      record: record || null
    });
  }

  async connectRecord(operation, record) {
    try {
      this.assertOperation(operation);
      const handle = this.dependencies.beginConnect(record);
      if (!handle?.attemptId || !handle?.ready) throw new Error("连接入口未返回 attempt handle");
      operation.attemptId = handle.attemptId;
      this.updateState({
        status: "connecting",
        attemptId: handle.attemptId,
        message: `正在连接角色 ${record.selectedRole}`
      });

      await handle.ready;
      this.assertOperation(operation);
      this.updateState({ status: "awaiting_hello", message: "连接已建立，正在等待服务器握手" });
      await this.dependencies.waitForHello(handle.attemptId);
      this.assertOperation(operation);

      this.activeOperation = null;
      this.updateState({ status: "connected", error: "", message: "角色切换完成" });
      return { ok: true, record, attemptId: handle.attemptId };
    } catch (error) {
      if (!this.isOperationCurrent(operation) || error instanceof ControllerOperationCancelled) {
        return { ok: false, cancelled: true };
      }
      if (operation.attemptId) {
        const reason = error?.code === "HELLO_TIMEOUT" ? "hello_timeout" : "role_switch_failed";
        this.dependencies.disconnectAttempt?.(operation.attemptId, reason);
      }
      this.activeOperation = null;
      this.updateState({ status: "reconnect_error", error: error.message, message: "连接失败，可重试" });
      return { ok: false, error, record };
    }
  }

  createOperation(accountKey, committed) {
    const operation = {
      id: ++this.operationId,
      accountKey,
      attemptId: 0,
      committed: Boolean(committed)
    };
    this.activeOperation = operation;
    return operation;
  }

  getExternalContext() {
    const profile = this.dependencies.getProfile?.();
    const accountKey = String(profile?.username || "").trim().toLowerCase();
    if (profile?.audience !== "external" || !accountKey) return null;
    return { profile, accountKey };
  }

  getCurrentRecord() {
    const dependencyRecord = this.dependencies.getCurrentRecord?.();
    if (dependencyRecord) this.currentRecord = dependencyRecord;
    return this.currentRecord;
  }

  isOperationCurrent(operation) {
    if (!operation || this.activeOperation !== operation || this.operationId !== operation.id) return false;
    const context = this.getExternalContext();
    return Boolean(context && context.accountKey === operation.accountKey);
  }

  assertOperation(operation) {
    if (!this.isOperationCurrent(operation)) throw new ControllerOperationCancelled();
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    this.dependencies.onState?.(this.snapshot());
  }
}
