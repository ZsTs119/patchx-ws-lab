import { createIdentity, createUuid, inferRoleFromDeviceId, ROLE_CODES } from "./core/identity-factory.js";
import { AudioStreamer, base64ToBlob, getProfileFromInputs } from "./core/audio-engine.js";
import { DownlinkAudioPlayer } from "./core/downlink-audio-player.js";
import { DevLabApi } from "./core/dev-lab-api.js";
import { eventText, ProtocolStore } from "./core/protocol-store.js";
import { ModuleHost } from "./core/module-host.js?v=20260526-ja-tts-split2";
import { ScenarioRunner } from "./core/scenario-runner.js";
import { WsClient } from "./core/ws-client.js";
import { enhanceFilePickers } from "./ui/file-picker.js";
import { activateTab, bindTabs } from "./ui/tabs.js";
import { enhanceSelectControls, refreshSelectControl, refreshSelectControls } from "./ui/select-popover.js?v=20260525-polish2";

const STORAGE_KEY = "patchx-ws-lab-v1";
const CUSTOM_ENDPOINT_ID = "custom";
const CUSTOM_TEMPLATE_PREFIX = "custom-protocol-";
const CAPABILITY_KEYS = ["rest", "personalities", "logs", "rounds", "logDetail", "tts", "scenarioEvidence"];
const REST_DEPENDENT_CAPABILITIES = ["personalities", "logs", "rounds", "logDetail", "tts", "scenarioEvidence"];

const builtInEndpointConfigs = [
  {
    id: "sprite-prod",
    label: "小精灵生产环境",
    ws: "wss://ws-lab.patch-x.cn/env/prod/ws",
    rest: "https://ws-lab.patch-x.cn/env/prod/api/v1/dev/ws-lab",
    remote: true
  },
  {
    id: "sprite-test",
    label: "小精灵测试环境",
    ws: "wss://ws-lab.patch-x.cn/env/test/ws",
    rest: "https://ws-lab.patch-x.cn/env/test/api/v1/dev/ws-lab",
    remote: true
  },
  {
    id: "sprite-ja",
    label: "小精灵日语环境",
    ws: "wss://ws-lab.patch-x.cn/env/ja/ws",
    rest: "https://ws-lab.patch-x.cn/env/ja/api/v1/dev/ws-lab",
    remote: true
  },
  {
    id: "sprite-en",
    label: "小精灵英语环境",
    ws: "wss://ws-lab.patch-x.cn/env/en/ws",
    rest: "https://ws-lab.patch-x.cn/env/en/api/v1/dev/ws-lab",
    remote: true
  },
  {
    id: "local",
    label: "本机默认",
    ws: "ws://localhost:8460",
    rest: "http://localhost:8410/api/v1/dev/ws-lab"
  },
  {
    id: "loopback",
    label: "127.0.0.1",
    ws: "ws://127.0.0.1:8460",
    rest: "http://127.0.0.1:8410/api/v1/dev/ws-lab"
  },
  {
    id: "page-host",
    label: "同域部署",
    ws: () => `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname || "127.0.0.1"}:8460`,
    rest: () => `${window.location.protocol === "https:" ? "https" : "http"}://${window.location.hostname || "127.0.0.1"}:8410/api/v1/dev/ws-lab`
  }
];

const templates = {
  listen_mode_start: {
    id: "listen_mode_start",
    label: "监听模式 · 开始",
    category: "监听模式",
    requires_session: true,
    payload: { type: "listen_mode", action: "start", session_type: "transcription" },
    params: [
      { path: "action", label: "动作", type: "string", options: ["start", "status", "end"] },
      { path: "session_type", label: "会话类型", type: "string", options: ["transcription", "chat"] }
    ],
    expect: [{ type: "listen_mode_status", timeout_ms: 5000, optional: true }]
  },
  listen_mode_status: {
    id: "listen_mode_status",
    label: "监听模式 · 状态",
    category: "监听模式",
    requires_session: true,
    payload: { type: "listen_mode", action: "status" },
    params: [{ path: "action", label: "动作", type: "string", options: ["start", "status", "end"] }],
    expect: [{ type: "listen_mode_status", timeout_ms: 5000 }]
  },
  listen_mode_end: {
    id: "listen_mode_end",
    label: "监听模式 · 结束",
    category: "监听模式",
    requires_session: true,
    payload: { type: "listen_mode", action: "end" },
    params: [{ path: "action", label: "动作", type: "string", options: ["start", "status", "end"] }],
    expect: [{ type: "listen_mode_status", timeout_ms: 5000, optional: true }]
  },
  active_greet: {
    id: "active_greet",
    label: "主动问候",
    category: "主动问候",
    requires_session: true,
    payload: { type: "active_greet" },
    params: [],
    expect: [{ type: "tts", timeout_ms: 12000, optional: true }]
  },
  touch_mood: {
    id: "touch_mood",
    label: "触摸 · 情绪",
    category: "交互",
    requires_session: true,
    payload: { type: "touch_mood" },
    params: [],
    expect: [{ type: "tts", timeout_ms: 12000, optional: true }]
  },
  touch_tarot: {
    id: "touch_tarot",
    label: "触摸 · 塔罗",
    category: "交互",
    requires_session: true,
    payload: { type: "touch_tarot" },
    params: [],
    expect: [{ type: "tts", timeout_ms: 12000, optional: true }]
  },
  sleep_on: {
    id: "sleep_on",
    label: "睡眠模式 · 开启",
    category: "状态",
    requires_session: true,
    payload: { type: "sleep_mode_switch", switch: "on" },
    params: [{ path: "switch", label: "开关", type: "string", options: ["on", "off"] }],
    expect: [{ type: "sleep_mode", timeout_ms: 5000, optional: true }]
  },
  sleep_off: {
    id: "sleep_off",
    label: "睡眠模式 · 关闭",
    category: "状态",
    requires_session: true,
    payload: { type: "sleep_mode_switch", switch: "off" },
    params: [{ path: "switch", label: "开关", type: "string", options: ["on", "off"] }],
    expect: [{ type: "sleep_mode", timeout_ms: 5000, optional: true }]
  },
  get_system_prompt: {
    id: "get_system_prompt",
    label: "读取系统提示词",
    category: "诊断",
    requires_session: true,
    payload: { type: "get_system_prompt" },
    params: [],
    expect: [{ type: "system_prompt", timeout_ms: 8000, optional: true }]
  },
  boot_greeting: {
    id: "boot_greeting",
    label: "开机问候",
    category: "主动问候",
    requires_session: true,
    payload: { type: "boot_greeting" },
    params: [],
    expect: [{ type: "tts", timeout_ms: 12000, optional: true }]
  },
  listen_manual_detect: {
    id: "listen_manual_detect",
    label: "文本输入 · listen detect",
    category: "输入",
    requires_session: true,
    payload: { type: "listen", mode: "manual", state: "detect", text: "你好，帮我做一次协议测试。" },
    params: [
      { path: "mode", label: "模式", type: "string", options: ["manual", "auto", "realtime"] },
      { path: "state", label: "状态", type: "string", options: ["start", "stop", "detect"] },
      { path: "text", label: "文本", type: "string" }
    ],
    expect: [{ type: "tts", timeout_ms: 12000, optional: true }]
  },
  listen_start: {
    id: "listen_start",
    label: "监听 · start",
    category: "输入",
    requires_session: true,
    payload: { type: "listen", state: "start", mode: "manual" },
    params: [
      { path: "state", label: "状态", type: "string", options: ["start", "stop", "detect"] },
      { path: "mode", label: "模式", type: "string", options: ["manual", "auto", "realtime"] }
    ]
  },
  listen_stop: {
    id: "listen_stop",
    label: "监听 · stop",
    category: "输入",
    requires_session: true,
    payload: { type: "listen", state: "stop", mode: "manual" },
    params: [
      { path: "state", label: "状态", type: "string", options: ["start", "stop", "detect"] },
      { path: "mode", label: "模式", type: "string", options: ["manual", "auto", "realtime"] }
    ]
  },
  interrupt: {
    id: "interrupt",
    label: "智能打断",
    category: "打断",
    requires_session: true,
    payload: { type: "interrupt" },
    params: [],
    expect: [{ type: "interrupt_complete", timeout_ms: 8000, optional: true }]
  },
  image_url: {
    id: "image_url",
    label: "图片 · URL",
    category: "视觉",
    requires_session: true,
    payload: { type: "image", text: "请描述这张图片", image_data: { url: "https://example.com/image.jpg", format: "jpeg" } },
    params: [
      { path: "text", label: "问题", type: "string" },
      { path: "image_data.url", label: "图片 URL", type: "string" },
      { path: "image_data.format", label: "格式", type: "string", options: ["jpeg", "png"] }
    ],
    expect: [{ type: "tts", timeout_ms: 15000, optional: true }]
  },
  vision_edge: {
    id: "vision_edge",
    label: "视觉 · 边缘识别",
    category: "视觉",
    requires_session: true,
    payload: { type: "vision", action: "edge_vision", data: "画面中有人靠近设备。" },
    params: [
      { path: "action", label: "动作", type: "string", options: ["edge_vision", "gen_pic", "gen_video", "read_img"] },
      { path: "data", label: "识别结果", type: "string" }
    ]
  },
  mcp_result: {
    id: "mcp_result",
    label: "MCP · result",
    category: "工具/MCP",
    requires_session: true,
    payload: { type: "mcp", payload: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "true" }], isError: false } } },
    params: [
      { path: "payload.id", label: "请求 ID", type: "number" },
      { path: "payload.result.content.0.text", label: "结果文本", type: "string" }
    ]
  },
  update_user_id: {
    id: "update_user_id",
    label: "用户切换",
    category: "身份",
    requires_session: true,
    payload: { type: "updateUserId", user_id: "{{user_id}}" },
    params: [{ path: "user_id", label: "用户 ID", type: "string" }],
    expect: [{ type: "updateUserId", timeout_ms: 5000, optional: true }]
  },
  auth_response: {
    id: "auth_response",
    label: "认证响应",
    category: "认证",
    requires_session: true,
    payload: { type: "auth_response", response: { device_id: "{{device_id}}", challenge_id: "challenge-id", signature: "signature", timestamp: 0 } },
    params: [
      { path: "response.challenge_id", label: "挑战 ID", type: "string" },
      { path: "response.signature", label: "签名", type: "string" },
      { path: "response.timestamp", label: "时间戳", type: "number" }
    ],
    expect: [{ type: "auth_result", timeout_ms: 5000, optional: true }]
  },
  audio_end: {
    id: "audio_end",
    label: "AudioEnd",
    category: "播放",
    requires_session: true,
    payload: { type: "AudioEnd", source: "client" },
    params: [{ path: "source", label: "来源", type: "string" }]
  },
  alarm_callback: {
    id: "alarm_callback",
    label: "闹钟回调",
    category: "设备能力",
    requires_session: true,
    payload: { type: "alarm", action: "trigger", alarm_id: "alarm-demo", text: "提醒时间到了" },
    params: [
      { path: "action", label: "动作", type: "string" },
      { path: "alarm_id", label: "闹钟 ID", type: "string" },
      { path: "text", label: "文本", type: "string" }
    ]
  },
  surround_detection: {
    id: "surround_detection",
    label: "环境感知",
    category: "设备能力",
    requires_session: true,
    payload: { type: "surround_detection", data: "检测到用户靠近设备" },
    params: [{ path: "data", label: "环境信息", type: "string" }]
  },
  iot_message: {
    id: "iot_message",
    label: "IOT 消息",
    category: "设备能力",
    requires_session: true,
    payload: { type: "iot", action: "status", data: { device: "lamp", state: "on" } },
    params: [
      { path: "action", label: "动作", type: "string" },
      { path: "data.device", label: "设备", type: "string" },
      { path: "data.state", label: "状态", type: "string" }
    ]
  },
  get_gesture: {
    id: "get_gesture",
    label: "手势识别结果",
    category: "设备能力",
    requires_session: true,
    payload: { type: "getGesture", gesture: "wave" },
    params: [{ path: "gesture", label: "手势", type: "string" }],
    expect: [{ type: "setGesture", timeout_ms: 5000, optional: true }]
  },
  wake_up: {
    id: "wake_up",
    label: "唤醒消息",
    category: "设备能力",
    requires_session: true,
    payload: { type: "wake_up", text: "小格小格" },
    params: [{ path: "text", label: "唤醒词", type: "string" }]
  }
};

const scenarios = {
  "role-text-smoke": {
    id: "role-text-smoke",
    label: "角色文本冒烟",
    area: "核心链路",
    builtin: true
  }
};

const fixedRoundNarrativeCards = [
  { key: "input", title: "输入与 ASR", modules: ["input"], required: true, empty: "未找到本轮文本输入或 ASR 识别文本。" },
  { key: "eou", title: "监听与判停", modules: ["eou"], requiredForAudio: true, empty: "文本轮次不强制 EOU；音频轮次需要判停证据。" },
  { key: "interrupt", title: "智能打断", modules: ["interrupt"], empty: "本轮没有发生用户打断或播放抢占。" },
  { key: "speaker", title: "身份与声纹", modules: ["speaker_verification"], empty: "未采集到声纹校验证据；如果本场景未启用声纹，可视为未触发。" },
  { key: "moderation", title: "安全审核", modules: ["moderation"], empty: "未采集到内容安全审核证据。" },
  { key: "state", title: "状态机", modules: ["state_machine"], empty: "未采集到服务端状态切换证据。" },
  { key: "intent", title: "意图与路由", modules: ["intent"], required: true, empty: "未找到本轮意图识别、instruction 或路由结果。" },
  { key: "memory", title: "记忆与推荐", modules: ["memory_recommendation"], empty: "本轮没有记忆检索、推荐或上下文注入证据。" },
  { key: "tools", title: "工具与外部能力", modules: ["tools"], empty: "本轮没有工具调用或外部能力证据。" },
  { key: "speculative", title: "投机与模型竞速", modules: ["speculative"], empty: "未采集到快慢模型竞速或投机退出证据。" },
  { key: "llm_request", title: "LLM 请求", modules: ["llm"], categories: ["llm_request"], required: true, empty: "未找到本轮 LLM 请求摘要。" },
  { key: "llm_response", title: "LLM 响应", modules: ["llm"], categories: ["llm_response", "llm"], required: true, empty: "未找到本轮 LLM 响应文本或 token 证据。" },
  { key: "reply_tts", title: "回复与 TTS", modules: ["pre_reply"], empty: "未采集到秒回、首句或回复进入播报前的证据。" },
  { key: "tts", title: "TTS 切片与下发", modules: ["tts"], required: true, empty: "未找到本轮 TTS 切片、合成或首包下发证据。" },
  { key: "expression", title: "表情动作与协议下发", modules: ["expression"], empty: "本轮没有表情、动作或额外协议下发证据。" },
  { key: "latency", title: "延迟汇总", modules: ["latency"], required: true, empty: "未找到轮次延迟汇总，无法对齐 ASR/LLM/TTS/E2E 指标。" },
  { key: "persistence", title: "持久化与收尾", modules: ["persistence", "unknown", "error"], empty: "未采集到对话历史、持久化、关闭或未归属证据。" }
];

const dom = {};
const store = new ProtocolStore();
const wsClient = new WsClient(store);
const api = new DevLabApi(() => dom.restBaseInput.value.trim());
const scenarioRunner = new ScenarioRunner({
  store,
  wsClient,
  api,
  getHello: () => buildHello(),
  getText: () => dom.textMessageInput.value.trim() || "你好，做一次冒烟测试。",
  getFilters: () => buildIdentityLogFilters(),
  getWsUrl: () => normalizeWsInput(dom.wsUrlInput.value),
  getIdentity: () => readIdentityFromInputs(),
  getCapabilities: () => exportCapabilities(),
  tools: {
    validateConnection: () => assertEndpointCompatibleWithPage(normalizeWsInput(dom.wsUrlInput.value), normalizeRestInput(dom.restBaseInput.value)),
    connectHello: () => openWsAndSendHello(),
    markHelloSent: () => markScenarioHelloSent(),
    setAudioProfile: (profile) => applyScenarioAudioProfile(profile),
    streamSilence: (durationMs) => streamScenarioSilence(durationMs),
    streamGeneratedTts: (text, options) => streamScenarioGeneratedTts(text, options)
  }
});

const state = {
  selectedRole: "01",
  identity: createIdentity("01"),
  personalities: null,
  activeAudioProfile: null,
  activePlaybackProfile: null,
  lastReport: null,
  templateDraft: null,
  customProtocolTemplates: [],
  uiMode: "pure",
  recentConversationKeys: [],
  activeTtsConversationSlots: new Map(),
  activeTtsConversationRecords: new Map(),
  ttsConversationSeq: 0,
  customEndpointConfigs: [],
  healthStatus: {
    rest: "unknown",
    message: "REST 未检查",
    checkedAt: ""
  },
  capabilities: createDefaultCapabilities(),
  environmentCapability: "checking",
  capabilityProbeId: 0,
  clientTab: "identityClientPanel",
  moduleSnapshot: null,
  logInsights: [],
  chainItems: [],
  logPaused: false,
  roundPaused: false,
  roundSessions: [],
  roundSummary: null,
  roundLogFile: "",
  rounds: [],
  selectedRoundId: "",
  selectedSessionId: "",
  restoredEndpointFromStorage: false,
  urlEndpointOverride: false,
  hasNewRounds: false,
  roundDetailCards: [],
  pendingExpectedInputTexts: []
};

let audioStreamer;
let downlinkAudioPlayer;
let moduleHost;
let capabilityProbeTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  try {
    init();
  } catch (error) {
    markBootError(error);
    throw error;
  }
});

function init() {
  bindDom();
  moduleHost = new ModuleHost({ store });
  audioStreamer = new AudioStreamer({
    wsClient,
    store,
    getProfile: () => ensureActiveAudioProfile(),
    getSessionId: () => wsClient.sessionId,
    onState: (value) => {
      dom.audioStateLabel.textContent = displayAudioState(value);
      updateMicButtonState(value);
    }
  });
  downlinkAudioPlayer = new DownlinkAudioPlayer({
    store,
    getProfile: () => ensureActivePlaybackProfile(),
    onState: updatePlaybackState
  });
  restoreState();
  registerCustomProtocolTemplates();
  applyUrlParams();
  applyRuntimeDefaultEndpoint();
  applyDisplayMode("pure");
  renderEndpointPresets();
  syncEndpointPresetSelections();
  renderRoles();
  renderTemplateOptions();
  renderScenarioOptions();
  renderScenarioMeta();
  writeIdentityToInputs();
  updateHelloPreview();
  updateCustomTemplate();
  renderInspectorContext();
  renderOverview();
  renderChainTimeline();
  enhanceSelectControls();
  enhanceFilePickers();
  bindTabs(dom.clientTabs);
  bindTabs(dom.inspectorTabs);
  bindTabs(dom.inputDockTabs);
  bindEvents();
  autoResizeComposer();
  updateQuickConnectionButton(dom.connectionPill?.dataset.state || "idle");
  updateMicButtonState();
  updatePlaybackState();
  commitCapabilities(state.capabilities, { preserveCheckedAt: true });
  store.subscribe(handleStoreUpdate);
  wsClient.onStateChange = updateConnectionState;
  wsClient.onSession = (sessionId) => {
    dom.sessionIdLabel.textContent = sessionId;
    dom.clientSessionLabel.textContent = shortText(sessionId);
    dom.clientHandshakeLabel.textContent = "握手完成";
    state.selectedSessionId = sessionId;
    state.activeAudioProfile ||= getDraftAudioProfile();
    state.activePlaybackProfile ||= getDraftPlaybackProfile();
    updateCustomTemplate();
    updateClientPanelState({ valid: true, stale: false, text: dom.helloValidity.textContent });
    renderInspectorContext();
    renderOverview();
  };
  store.add({ direction: "system", type: "lab", label: "ready", payload: { message: "WS Lab ready" } });
  window.setInterval(() => {
    if (!state.logPaused && dom.logsView && !dom.logsView.hidden) {
      refreshLogs({ silent: true });
    }
    if (!state.roundPaused && dom.roundView && !dom.roundView.hidden) {
      refreshRounds({ silent: true });
    }
  }, 8000);
  markBootReady();
  probeEnvironmentCapabilities({ silent: true, force: true })
    .finally(() => loadModules().then(() => maybeRunUrlAutomation()));
}

function bindDom() {
  for (const element of document.querySelectorAll("[id]")) {
    dom[element.id] = element;
  }
}

function bindEvents() {
  dom.clientTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab-target]");
    if (!tab) return;
    state.clientTab = tab.dataset.tabTarget;
    saveState();
  });
  dom.inspectorTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab-target]");
    if (!tab) return;
    if (tab.dataset.tabTarget === "roundView") {
      window.setTimeout(() => refreshRounds({ force: true }), 0);
    } else if (tab.dataset.tabTarget === "logsView") {
      window.setTimeout(() => refreshLogs({ force: true }), 0);
    }
  });
  dom.focusInspectorBtn?.addEventListener("click", toggleInspectorFocus);
  dom.refreshInspectorBtn?.addEventListener("click", async () => {
    await probeEnvironmentCapabilities({ silent: true, force: true });
    refreshActiveInspectorView();
  });
  dom.openClientDrawerBtn?.addEventListener("click", () => openDrawer("client"));
  dom.closeClientDrawerBtn?.addEventListener("click", () => closeDrawer("client"));
  dom.openInspectorDrawerBtn?.addEventListener("click", handleOpenInspectorDrawer);
  dom.closeInspectorDrawerBtn?.addEventListener("click", () => closeDrawer("inspector"));
  dom.drawerBackdrop?.addEventListener("click", closeAllDrawers);
  dom.manageCapabilityEndpointBtn?.addEventListener("click", () => {
    hideCapabilityNotice();
    openEndpointDialog();
  });
  dom.dismissCapabilityNoticeBtn?.addEventListener("click", hideCapabilityNotice);
  dom.quickConnectBtn?.addEventListener("click", handleQuickConnectionAction);
  dom.playbackToggleBtn?.addEventListener("click", handlePlaybackToggleAction);
  dom.playbackStateLabel?.addEventListener("click", handlePlaybackToggleAction);
  dom.openProtocolDrawerBtn?.addEventListener("click", openProtocolWorkspace);
  dom.openProtocolBtn?.addEventListener("click", openProtocolWorkspace);
  dom.closeProtocolWorkspaceBtn?.addEventListener("click", closeProtocolWorkspace);
  dom.toggleAudioPanelBtn?.addEventListener("click", toggleAudioPanel);
  dom.closeAudioPanelBtn?.addEventListener("click", closeAudioPanel);
  for (const button of [dom.modePureBtn, dom.modeLabBtn, dom.modeDiagnosisBtn]) {
    button?.addEventListener("click", () => applyDisplayMode(button.dataset.mode || "pure"));
  }
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!dom.protocolDockPanel?.hidden) {
      closeProtocolWorkspace();
      return;
    }
    closeAllDrawers();
  });

  dom.randomizeBtn.addEventListener("click", () => {
    state.identity = createIdentity(state.selectedRole);
    writeIdentityToInputs();
    renderRoles();
    updateHelloPreview();
  });

  dom.refreshIdentityBtn.addEventListener("click", refreshIdentityForRole);
  dom.refreshTraceBtn.addEventListener("click", refreshTraceId);
  dom.copyIdentityBtn.addEventListener("click", copyIdentityJson);
  dom.applyIdentityJsonBtn.addEventListener("click", applyIdentityJson);
  dom.syncRoleFromDeviceBtn.addEventListener("click", syncSelectedRoleFromDevice);

  dom.deviceIdInput.addEventListener("input", () => {
    updateHelloPreview();
  });

  dom.endpointPresetSelect.addEventListener("change", applyEndpointPreset);
  dom.saveEndpointBtn.addEventListener("click", openEndpointDialog);
  dom.closeEndpointDialogBtn.addEventListener("click", closeEndpointDialog);
  dom.cancelEndpointDialogBtn.addEventListener("click", closeEndpointDialog);
  dom.newEndpointBtn.addEventListener("click", startNewEndpointConfig);
  dom.applyEndpointDialogBtn.addEventListener("click", applyEndpointDialogDraft);
  dom.saveEndpointDialogBtn.addEventListener("click", saveEndpointDialogConfig);
  dom.deleteEndpointBtn.addEventListener("click", deleteEndpointDialogConfig);
  dom.endpointDialog.addEventListener("click", (event) => {
    if (event.target === dom.endpointDialog) closeEndpointDialog();
  });

  for (const id of [
    "userIdInput",
    "traceIdInput",
    "clientIdInput",
    "deviceMacInput",
    "clientIpInput",
    "tokenInput",
    "deviceNameInput",
    "audioFormatInput",
    "sampleRateInput",
    "frameDurationInput",
    "playbackFormatInput",
    "playbackSampleRateInput",
    "playbackFrameDurationInput",
    "sleepModeInput",
    "helloClientIdInput",
    "helloTokenToggle",
    "helloDeviceNameToggle",
    "helloDeviceMacToggle",
    "helloPlaybackToggle",
    "helloFeaturesToggle",
    "helloLocationToggle",
    "helloClientInfoToggle",
    "helloSessionToggle",
    "helloSessionInput",
    "helloFeaturesInput",
    "helloLongitudeInput",
    "helloLatitudeInput",
    "helloAddressInput",
    "helloAdCodeInput",
    "helloOsTypeInput",
    "helloAppVersionInput",
    "helloNetworkTypeInput",
    "helloBatteryInput",
    "helloExtraInput",
    "wsUrlInput",
    "restBaseInput"
  ]) {
    dom[id].addEventListener("input", () => {
      if (id === "wsUrlInput" || id === "restBaseInput") {
        syncEndpointPresetSelections();
        scheduleCapabilityProbe();
      }
      updateHelloPreview();
      saveState();
    });
    dom[id].addEventListener("change", () => {
      if (id === "wsUrlInput" || id === "restBaseInput") {
        syncEndpointPresetSelections();
        scheduleCapabilityProbe(0);
      }
      updateHelloPreview();
      saveState();
    });
  }

  for (const button of document.querySelectorAll("[data-audio-preset]")) {
    button.addEventListener("click", () => applyAudioPreset(button.dataset.audioPreset));
  }

  dom.healthBtn?.addEventListener("click", checkHealth);
  dom.endpointHealthBtn?.addEventListener("click", checkHealth);
  dom.connectBtn.addEventListener("click", connectAndHello);
  dom.disconnectBtn.addEventListener("click", () => wsClient.disconnect());
  dom.copyHelloBtn.addEventListener("click", copyHelloJson);
  dom.expandHelloBtn.addEventListener("click", openHelloDialog);
  dom.resetHelloBtn.addEventListener("click", resetHelloOptions);
  dom.closeHelloDialogBtn.addEventListener("click", () => dom.helloDialog.close());
  dom.helloDialog.addEventListener("click", (event) => {
    if (event.target === dom.helloDialog) dom.helloDialog.close();
  });
  dom.closeInspectorDetailBtn.addEventListener("click", closeInspectorDetail);
  dom.inspectorDetailDialog.addEventListener("click", (event) => {
    if (event.target === dom.inspectorDetailDialog) closeInspectorDetail();
  });
  dom.sendTextBtn.addEventListener("click", sendText);
  dom.textMessageInput.addEventListener("keydown", handleTextComposerKeydown);
  dom.textMessageInput.addEventListener("input", autoResizeComposer);
  dom.formatCustomBtn.addEventListener("click", formatCustomJson);
  dom.sendCustomBtn.addEventListener("click", sendCustomJson);
  dom.templateSelect.addEventListener("change", updateCustomTemplate);
  dom.saveProtocolTemplateBtn?.addEventListener("click", saveProtocolTemplate);
  dom.deleteProtocolTemplateBtn?.addEventListener("click", deleteProtocolTemplate);
  dom.exportProtocolTemplateBtn?.addEventListener("click", exportProtocolTemplate);
  dom.importProtocolTemplateBtn?.addEventListener("click", importProtocolTemplate);
  dom.refreshLogsBtn.addEventListener("click", () => refreshLogs({ force: true }));
  dom.pauseLogsBtn.addEventListener("click", toggleLogPause);
  dom.logScopeSelect.addEventListener("change", () => refreshLogs({ force: true }));
  dom.logPhaseSelect.addEventListener("change", () => refreshLogs({ force: true }));
  dom.logLevelSelect.addEventListener("change", () => refreshLogs({ force: true }));
  dom.logSinceSelect.addEventListener("change", () => refreshLogs({ force: true }));
  dom.logErrorOnlyInput.addEventListener("change", () => refreshLogs({ force: true }));
  dom.logTurnInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") refreshLogs({ force: true });
  });
  dom.refreshRoundsBtn.addEventListener("click", () => refreshRounds({ force: true }));
  dom.roundSessionSelect?.addEventListener("change", handleRoundSessionChange);
  dom.roundFollowLatestInput?.addEventListener("change", () => refreshRounds({ force: true }));
  dom.roundErrorOnlyInput.addEventListener("change", () => refreshRounds({ force: true }));
  dom.roundMissingInput.addEventListener("change", () => refreshRounds({ force: true }));
  dom.roundUnknownInput.addEventListener("change", () => refreshRounds({ force: true }));
  dom.roundList.addEventListener("click", handleRoundListClick);
  dom.roundDetail.addEventListener("click", handleRoundDetailClick);
  dom.logInsightList.addEventListener("click", handleLogInsightClick);
  if (dom.chainTimeline) {
    dom.chainTimeline.addEventListener("click", handleChainTimelineClick);
  }
  dom.runScenarioBtn.addEventListener("click", runSmokeScenario);
  dom.scenarioSelect.addEventListener("change", renderScenarioMeta);
  dom.copyJsonReportBtn.addEventListener("click", () => copyReport("json"));
  dom.copyMarkdownReportBtn.addEventListener("click", () => copyReport("markdown"));
  dom.copyScenarioBtn.addEventListener("click", copySelectedScenario);
  dom.importScenarioBtn.addEventListener("click", importScenario);
  dom.streamWavBtn.addEventListener("click", streamSelectedWav);
  dom.startSilenceBtn.addEventListener("click", () => runAudioAction(() => audioStreamer.startSilence()));
  dom.pauseSilenceBtn.addEventListener("click", () => audioStreamer.pause());
  dom.resumeSilenceBtn.addEventListener("click", () => audioStreamer.resume());
  dom.stopAudioBtn.addEventListener("click", () => audioStreamer.stop());
  dom.startMicBtn.addEventListener("click", toggleMicInput);
  dom.audioMicBtn?.addEventListener("click", toggleMicInput);
  dom.generateTtsBtn.addEventListener("click", generateAndStreamTts);
}

function applyDisplayMode(mode = "pure") {
  const next = ["pure", "lab", "diagnosis"].includes(mode) ? mode : "pure";
  state.uiMode = next;
  dom.appShell.classList.toggle("mode-pure", next === "pure");
  dom.appShell.classList.toggle("mode-lab", next === "lab");
  dom.appShell.classList.toggle("mode-diagnosis", next === "diagnosis");
  dom.appShell.classList.remove("inspector-focus");
  for (const button of [dom.modePureBtn, dom.modeLabBtn, dom.modeDiagnosisBtn]) {
    button?.setAttribute("aria-pressed", String(button.dataset.mode === next));
  }
  if (dom.focusInspectorBtn) {
    dom.focusInspectorBtn.textContent = next === "diagnosis" ? "退出聚焦" : "聚焦诊断";
    dom.focusInspectorBtn.setAttribute("aria-pressed", String(next === "diagnosis"));
  }
  if (next === "lab" || next === "diagnosis") {
    closeAllDrawers();
  }
  if (next === "diagnosis") {
    window.setTimeout(() => refreshActiveInspectorView(), 0);
  }
  updateBackdrop();
}

function openDrawer(name) {
  if (state.uiMode === "lab" || (state.uiMode === "diagnosis" && name === "client")) {
    applyDisplayMode("pure");
  }
  if (state.uiMode === "diagnosis" && name === "inspector") {
    refreshActiveInspectorView();
    return;
  }
  if (name === "client") {
    dom.appShell.classList.add("drawer-client-open");
  } else if (name === "inspector") {
    dom.appShell.classList.add("drawer-inspector-open");
    window.setTimeout(() => refreshActiveInspectorView(), 0);
  }
  updateBackdrop();
}

async function handleOpenInspectorDrawer() {
  if (state.environmentCapability === "checking" || state.capabilities.rest.status === "unknown") {
    await probeEnvironmentCapabilities({ silent: true, force: true });
  }
  if (!isCapabilityOk("rest")) {
    showCapabilityNotice("诊断不可用", inspectorUnavailableReason());
    store.add({ direction: "system", type: "rest", error: inspectorUnavailableReason() });
    return;
  }
  openDrawer("inspector");
}

function showCapabilityNotice(title, text) {
  if (!dom.capabilityNotice) return;
  dom.capabilityNoticeTitle.textContent = title;
  dom.capabilityNoticeText.textContent = text;
  dom.capabilityNotice.hidden = false;
  window.clearTimeout(showCapabilityNotice.timer);
  showCapabilityNotice.timer = window.setTimeout(hideCapabilityNotice, 7000);
}

function hideCapabilityNotice() {
  if (dom.capabilityNotice) dom.capabilityNotice.hidden = true;
}

function closeDrawer(name) {
  if (name === "client") dom.appShell.classList.remove("drawer-client-open");
  if (name === "inspector") dom.appShell.classList.remove("drawer-inspector-open");
  updateBackdrop();
}

function closeAllDrawers() {
  dom.appShell.classList.remove("drawer-client-open", "drawer-inspector-open");
  updateBackdrop();
}

function updateBackdrop() {
  const active = dom.appShell.classList.contains("drawer-client-open")
    || dom.appShell.classList.contains("drawer-inspector-open")
    || (dom.protocolDockPanel && !dom.protocolDockPanel.hidden);
  if (dom.drawerBackdrop) dom.drawerBackdrop.hidden = !active;
}

function openProtocolWorkspace() {
  if (!dom.protocolDockPanel) return;
  dom.protocolDockPanel.hidden = false;
  dom.protocolDockPanel.classList.add("active");
  dom.appShell.classList.add("protocol-open");
  dom.openProtocolDrawerBtn?.setAttribute("aria-pressed", "true");
  dom.openProtocolBtn?.setAttribute("aria-pressed", "true");
  updateCustomTemplate();
  updateBackdrop();
  window.setTimeout(() => dom.customJsonInput?.focus({ preventScroll: true }), 80);
}

function closeProtocolWorkspace() {
  if (!dom.protocolDockPanel) return;
  dom.protocolDockPanel.hidden = true;
  dom.protocolDockPanel.classList.remove("active");
  dom.appShell.classList.remove("protocol-open");
  dom.openProtocolDrawerBtn?.setAttribute("aria-pressed", "false");
  dom.openProtocolBtn?.setAttribute("aria-pressed", "false");
  updateBackdrop();
}

function toggleAudioPanel() {
  const show = dom.audioDockPanel.hidden;
  dom.audioDockPanel.hidden = !show;
  dom.audioDockPanel.classList.toggle("active", show);
  dom.toggleAudioPanelBtn.setAttribute("aria-expanded", String(show));
}

function closeAudioPanel() {
  dom.audioDockPanel.hidden = true;
  dom.audioDockPanel.classList.remove("active");
  dom.toggleAudioPanelBtn?.setAttribute("aria-expanded", "false");
}

function autoResizeComposer() {
  const input = dom.textMessageInput;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 48), 112)}px`;
}

function isMobileLayout() {
  return window.matchMedia?.("(max-width: 1180px)").matches || window.innerWidth <= 1180;
}

function toggleInspectorFocus() {
  if (isMobileLayout()) {
    applyDisplayMode("pure");
    openDrawer("inspector");
    return;
  }
  applyDisplayMode(state.uiMode === "diagnosis" ? "pure" : "diagnosis");
}

function refreshActiveInspectorView() {
  const active = dom.inspectorTabs?.querySelector('[aria-selected="true"]')?.dataset?.tabTarget || "overviewView";
  if (active === "roundView") {
    if (!isCapabilityOk("rounds")) {
      renderRoundUnavailable(capabilityUnavailableText("rounds"));
      return;
    }
    refreshRounds({ force: true });
    return;
  }
  if (active === "logsView") {
    if (!isCapabilityOk("logs")) {
      renderLogUnavailable(capabilityUnavailableText("logs"));
      return;
    }
    refreshLogs({ force: true });
    return;
  }
  if (active === "scenarioView") {
    renderScenarioMeta();
    if (state.moduleSnapshot) renderModules(state.moduleSnapshot);
    return;
  }
  renderOverview();
}

function renderEndpointPresets() {
  const configs = getEndpointConfigs();
  renderEndpointSelect(dom.endpointPresetSelect, configs);
  refreshSelectControl(dom.endpointPresetSelect);
}

function renderEndpointSelect(select, configs) {
  select.innerHTML = "";
  for (const config of configs) {
    const option = document.createElement("option");
    option.value = config.id;
    option.textContent = config.label;
    option.title = endpointOptionTitle(config);
    select.appendChild(option);
  }
  const option = document.createElement("option");
  option.value = CUSTOM_ENDPOINT_ID;
  option.textContent = "自定义";
  option.title = "当前未保存的 WS/REST 地址";
  select.appendChild(option);
}

function applyEndpointPreset() {
  const select = dom.endpointPresetSelect;
  if (select.value === CUSTOM_ENDPOINT_ID) {
    refreshEndpointSelectControls();
    saveState();
    window.setTimeout(() => openEndpointDialog(), 0);
    return;
  }
  const config = getEndpointConfigById(select.value);
  if (!config) return;
  applyEndpointConfig(config);
  updateHelloPreview();
  saveState();
  scheduleCapabilityProbe(0);
}

function syncEndpointPresetSelections() {
  const matched = getEndpointConfigByValues(dom.wsUrlInput.value, dom.restBaseInput.value);
  const selectedId = matched?.id || CUSTOM_ENDPOINT_ID;
  dom.endpointPresetSelect.value = selectedId;
  refreshEndpointSelectControls();
}

function applyEndpointConfig(config) {
  const resolved = resolveEndpointConfig(config);
  dom.wsUrlInput.value = resolved.ws;
  dom.restBaseInput.value = resolved.rest;
  dom.endpointPresetSelect.value = resolved.id;
  refreshEndpointSelectControls();
}

function getEndpointConfigs() {
  return [
    ...builtInEndpointConfigs.map(resolveEndpointConfig),
    ...state.customEndpointConfigs.map(resolveEndpointConfig)
  ];
}

function getEndpointConfigById(id) {
  return getEndpointConfigs().find((config) => config.id === id);
}

function getEndpointConfigByValues(ws, rest) {
  const normalizedWs = normalizeEndpointValue(ws);
  const normalizedRest = normalizeEndpointValue(rest);
  return getEndpointConfigs().find((config) => normalizeEndpointValue(config.ws) === normalizedWs && normalizeEndpointValue(config.rest) === normalizedRest);
}

function resolveEndpointConfig(config) {
  return {
    ...config,
    ws: resolveEndpointValue(config.ws),
    rest: resolveEndpointValue(config.rest)
  };
}

function resolveEndpointValue(value) {
  return typeof value === "function" ? value() : value;
}

function normalizeEndpointValue(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeWsInput(value) {
  const raw = normalizeEndpointValue(value);
  if (!raw) return "";
  return /^wss?:\/\//i.test(raw) ? raw : `wss://${raw}`;
}

function normalizeRestInput(value) {
  const raw = normalizeEndpointValue(value);
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/api/v1/dev/ws-lab";
    }
    return normalizeEndpointValue(url.toString());
  } catch {
    return withScheme;
  }
}

function isLocalRuntime() {
  const host = (window.location.hostname || "").toLowerCase();
  return !host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function isHostedStaticRuntime() {
  return window.location.protocol === "https:" && !isLocalRuntime();
}

function getDefaultEndpointIdForRuntime() {
  return isHostedStaticRuntime() ? "sprite-prod" : "local";
}

function applyRuntimeDefaultEndpoint() {
  if (state.restoredEndpointFromStorage || state.urlEndpointOverride) return;
  const config = getEndpointConfigById(getDefaultEndpointIdForRuntime());
  if (config) applyEndpointConfig(config);
}

function assertEndpointCompatibleWithPage(ws, rest) {
  if (window.location.protocol !== "https:") return;
  if (/^ws:\/\//i.test(ws)) {
    throw new Error("当前页面是 HTTPS，请使用 wss:// WebSocket 地址；本地 ws:// 调试请用 http://127.0.0.1:5177/ 打开。");
  }
  if (/^http:\/\//i.test(rest)) {
    throw new Error("当前页面是 HTTPS，请使用 https:// REST 地址；本地 http:// 诊断请用 http://127.0.0.1:5177/ 打开。");
  }
}

function refreshEndpointSelectControls() {
  refreshSelectControl(dom.endpointPresetSelect);
}

function validateEndpointDraft(ws, rest) {
  if (!/^wss?:\/\//i.test(ws)) return "WS 地址需要以 ws:// 或 wss:// 开头";
  if (!/^https?:\/\//i.test(rest)) return "REST 地址需要以 http:// 或 https:// 开头";
  return "";
}

function createCustomEndpointLabel(ws) {
  try {
    const url = new URL(ws);
    return `自定义 · ${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "自定义环境";
  }
}

function endpointOptionTitle(config) {
  const resolved = resolveEndpointConfig(config);
  return `${resolved.label}\nWS ${resolved.ws}\nREST ${resolved.rest}`;
}

function announceEndpointSave(label) {
  const original = "管理";
  const originalTitle = "管理自定义连接配置";
  dom.saveEndpointBtn.textContent = label.length > 4 ? "无效" : label;
  dom.saveEndpointBtn.title = label;
  window.setTimeout(() => {
    dom.saveEndpointBtn.textContent = original;
    dom.saveEndpointBtn.title = originalTitle;
  }, 1200);
  store.add({ direction: "system", type: "lab", label: "endpoint", payload: { message: label } });
}

function openEndpointDialog() {
  renderEndpointManagerList();
  selectEndpointForEditing(dom.endpointPresetSelect.value || CUSTOM_ENDPOINT_ID);
  setEndpointDialogStatus("");
  if (typeof dom.endpointDialog.showModal === "function") {
    dom.endpointDialog.showModal();
  } else {
    dom.endpointDialog.setAttribute("open", "");
  }
  dom.endpointNameInput.focus({ preventScroll: true });
  dom.endpointNameInput.select();
}

function closeEndpointDialog() {
  if (dom.endpointDialog.open && typeof dom.endpointDialog.close === "function") {
    dom.endpointDialog.close();
  } else {
    dom.endpointDialog.removeAttribute("open");
  }
}

function renderEndpointManagerList(selectedId = dom.endpointDialog.dataset.sourceId || dom.endpointPresetSelect.value || CUSTOM_ENDPOINT_ID) {
  dom.endpointConfigList.innerHTML = "";
  renderEndpointSection("内置", builtInEndpointConfigs.map(resolveEndpointConfig), selectedId);
  renderEndpointSection("自定义", state.customEndpointConfigs.map(resolveEndpointConfig), selectedId);
  renderEndpointSection("草稿", [getCurrentDraftEndpointConfig()], selectedId);
}

function renderEndpointSection(title, configs, selectedId) {
  const section = document.createElement("section");
  section.className = "endpoint-section";
  const heading = document.createElement("div");
  heading.className = "endpoint-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  if (!configs.length) {
    const empty = document.createElement("p");
    empty.className = "endpoint-empty";
    empty.textContent = "暂无";
    section.appendChild(empty);
  }

  for (const config of configs) {
    const resolved = resolveEndpointConfig(config);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "endpoint-option";
    button.dataset.endpointId = resolved.id;
    button.setAttribute("aria-selected", String(resolved.id === selectedId));
    button.title = endpointOptionTitle(resolved);
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = resolved.label;
    button.querySelector("span").textContent = endpointSummary(resolved);
    button.addEventListener("click", () => selectEndpointForEditing(resolved.id));
    section.appendChild(button);
  }

  dom.endpointConfigList.appendChild(section);
}

function selectEndpointForEditing(id) {
  const config = getEndpointConfigById(id) || getCurrentDraftEndpointConfig();
  const resolved = resolveEndpointConfig(config);
  const isCustom = Boolean(state.customEndpointConfigs.find((item) => item.id === resolved.id));
  const isDraft = resolved.id === CUSTOM_ENDPOINT_ID;

  dom.endpointDialog.dataset.sourceId = resolved.id;
  dom.endpointDialog.dataset.editId = isCustom ? resolved.id : "";
  dom.endpointNameInput.value = resolved.label || createCustomEndpointLabel(resolved.ws);
  dom.endpointWsInput.value = normalizeEndpointValue(resolved.ws);
  dom.endpointRestInput.value = normalizeEndpointValue(resolved.rest);
  dom.endpointDialogTitle.textContent = isCustom ? "编辑自定义连接" : isDraft ? "当前自定义草稿" : "内置环境";
  dom.saveEndpointDialogBtn.textContent = isCustom ? "保存修改" : "保存为自定义";
  dom.deleteEndpointBtn.disabled = !isCustom;
  dom.deleteEndpointBtn.title = isCustom ? "删除当前自定义连接" : "内置或未保存配置不能删除";
  setEndpointDialogStatus("");
  renderEndpointManagerList(resolved.id);
}

function startNewEndpointConfig() {
  const ws = normalizeEndpointValue(dom.wsUrlInput.value);
  const rest = normalizeEndpointValue(dom.restBaseInput.value);
  dom.endpointDialog.dataset.sourceId = "new";
  dom.endpointDialog.dataset.editId = "";
  dom.endpointNameInput.value = "";
  dom.endpointWsInput.value = ws;
  dom.endpointRestInput.value = rest;
  dom.endpointDialogTitle.textContent = "新建自定义连接";
  dom.saveEndpointDialogBtn.textContent = "保存为自定义";
  dom.deleteEndpointBtn.disabled = true;
  dom.deleteEndpointBtn.title = "新建配置尚未保存";
  setEndpointDialogStatus("");
  renderEndpointManagerList("new");
  dom.endpointNameInput.focus({ preventScroll: true });
}

function applyEndpointDialogDraft() {
  const ws = normalizeWsInput(dom.endpointWsInput.value);
  const rest = normalizeRestInput(dom.endpointRestInput.value);
  const validationError = validateEndpointDraft(ws, rest);
  if (validationError) {
    setEndpointDialogStatus(validationError, "error");
    return;
  }
  dom.wsUrlInput.value = ws;
  dom.restBaseInput.value = rest;
  syncEndpointPresetSelections();
  updateHelloPreview();
  saveState();
  scheduleCapabilityProbe(0);
  closeEndpointDialog();
  announceEndpointSave("已应用");
}

function saveEndpointDialogConfig() {
  const editId = dom.endpointDialog.dataset.editId;
  const label = dom.endpointNameInput.value.trim();
  const ws = normalizeWsInput(dom.endpointWsInput.value);
  const rest = normalizeRestInput(dom.endpointRestInput.value);
  const validationError = validateEndpointDialogDraft(label, ws, rest);
  if (validationError) {
    setEndpointDialogStatus(validationError, "error");
    return;
  }

  const duplicateCustom = state.customEndpointConfigs.find((config) => config.id !== editId && normalizeEndpointValue(config.ws) === ws && normalizeEndpointValue(config.rest) === rest);
  if (duplicateCustom) {
    setEndpointDialogStatus(`该地址已保存为「${duplicateCustom.label}」。`, "error");
    return;
  }

  const config = editId ? state.customEndpointConfigs.find((item) => item.id === editId) : null;
  if (config) {
    config.label = label;
    config.ws = ws;
    config.rest = rest;
  } else {
    state.customEndpointConfigs.push({
      id: `custom-${Date.now().toString(36)}`,
      label,
      ws,
      rest,
      custom: true
    });
  }

  const selected = config || state.customEndpointConfigs.at(-1);
  renderEndpointPresets();
  applyEndpointConfig(selected);
  updateHelloPreview();
  saveState();
  scheduleCapabilityProbe(0);
  renderEndpointManagerList(selected.id);
  closeEndpointDialog();
  announceEndpointSave(editId ? "已修改" : "已保存");
}

function deleteEndpointDialogConfig() {
  const editId = dom.endpointDialog.dataset.editId;
  const active = state.customEndpointConfigs.find((item) => item.id === editId);
  if (!active) {
    setEndpointDialogStatus("内置或未保存配置不能删除。", "error");
    return;
  }
  const ws = normalizeWsInput(dom.endpointWsInput.value || active.ws);
  const rest = normalizeRestInput(dom.endpointRestInput.value || active.rest);
  state.customEndpointConfigs = state.customEndpointConfigs.filter((item) => item.id !== editId);
  renderEndpointPresets();
  dom.wsUrlInput.value = ws;
  dom.restBaseInput.value = rest;
  dom.endpointPresetSelect.value = CUSTOM_ENDPOINT_ID;
  refreshEndpointSelectControls();
  updateHelloPreview();
  saveState();
  scheduleCapabilityProbe(0);
  renderEndpointManagerList(CUSTOM_ENDPOINT_ID);
  closeEndpointDialog();
  announceEndpointSave("已删除");
}

function getSelectedCustomEndpointConfig() {
  const id = dom.endpointPresetSelect.value;
  return state.customEndpointConfigs.find((config) => config.id === id);
}

function getCurrentDraftEndpointConfig() {
  return {
    id: CUSTOM_ENDPOINT_ID,
    label: "当前自定义",
    ws: normalizeEndpointValue(dom.wsUrlInput.value),
    rest: normalizeEndpointValue(dom.restBaseInput.value),
    draft: true
  };
}

function endpointSummary(config) {
  try {
    const ws = new URL(config.ws);
    const rest = new URL(config.rest);
    const wsHost = `${ws.hostname}${ws.port ? `:${ws.port}` : ""}`;
    const restHost = `${rest.hostname}${rest.port ? `:${rest.port}` : ""}`;
    return wsHost === restHost ? wsHost : `${wsHost} / ${restHost}`;
  } catch {
    return `${config.ws} / ${config.rest}`;
  }
}

function validateEndpointDialogDraft(label, ws, rest) {
  if (!label) return "请填写配置名称。";
  if (label.length > 60) return "配置名称最多 60 个字符。";
  return validateEndpointDraft(ws, rest);
}

function setEndpointDialogStatus(message, tone = "") {
  dom.endpointDialogStatus.textContent = message;
  if (tone) {
    dom.endpointDialogStatus.dataset.tone = tone;
  } else {
    delete dom.endpointDialogStatus.dataset.tone;
  }
}

function renderRoles() {
  dom.roleGrid.innerHTML = "";
  for (const code of ROLE_CODES) {
    const button = document.createElement("button");
    button.className = "role-button";
    button.type = "button";
    button.textContent = code;
    button.setAttribute("aria-pressed", String(code === state.selectedRole));
    button.dataset.testid = `role-${code}`;
    button.addEventListener("click", () => {
      state.selectedRole = code;
      state.identity = createIdentity(code);
      writeIdentityToInputs();
      renderRoles();
      updateHelloPreview();
    });
    dom.roleGrid.appendChild(button);
  }
  dom.identityRoleHint.textContent = `Device 第 3/4 位 = ${state.selectedRole}`;
  if (state.personalities) {
    renderPersonalityHints();
  }
  updateIdentityStatus();
}

function refreshIdentityForRole() {
  const current = readIdentityFromInputs();
  const next = createIdentity(state.selectedRole);
  state.identity = {
    ...current,
    roleCode: state.selectedRole,
    deviceId: next.deviceId,
    userId: next.userId,
    deviceMac: next.deviceMac,
    deviceName: next.deviceName
  };
  writeIdentityToInputs();
  renderRoles();
  updateHelloPreview();
  store.add({ direction: "system", type: "lab", label: "已刷新用户/设备", payload: { role: state.selectedRole } });
}

function refreshTraceId() {
  dom.traceIdInput.value = createUuid();
  updateHelloPreview();
  saveState();
  store.add({ direction: "system", type: "lab", label: "已刷新 Trace", payload: { trace_id: dom.traceIdInput.value } });
}

async function copyIdentityJson() {
  try {
    const identity = readIdentityFromInputs();
    await navigator.clipboard.writeText(JSON.stringify(identity, null, 2));
    store.add({ direction: "system", type: "report", label: "已复制身份 JSON", payload: { role: state.selectedRole } });
  } catch (error) {
    store.add({ direction: "system", type: "error", error: `身份 JSON 无法复制: ${error.message}` });
  }
}

function applyIdentityJson() {
  try {
    const text = dom.identityJsonInput.value.trim();
    if (!text) return;
    const payload = JSON.parse(text);
    const current = readIdentityFromInputs();
    const next = {
      ...current,
      deviceId: valueFrom(payload, "deviceId", "device_id") || current.deviceId,
      userId: valueFrom(payload, "userId", "user_id") || current.userId,
      traceId: valueFrom(payload, "traceId", "trace_id") || current.traceId,
      clientId: valueFrom(payload, "clientId", "client_id") || current.clientId,
      deviceMac: valueFrom(payload, "deviceMac", "device_mac") || current.deviceMac,
      clientIp: valueFrom(payload, "clientIp", "client_ip") || current.clientIp,
      deviceName: valueFrom(payload, "deviceName", "device_name") || current.deviceName,
      token: valueFrom(payload, "token") || current.token
    };
    state.identity = next;
    writeIdentityToInputs();
    renderRoles();
    updateHelloPreview();
    dom.identityJsonInput.classList.remove("invalid");
    store.add({ direction: "system", type: "lab", label: "已应用身份 JSON", payload: { fields: Object.keys(payload).length } });
  } catch (error) {
    dom.identityJsonInput.classList.add("invalid");
    store.add({ direction: "system", type: "error", error: `身份 JSON 无效: ${error.message}` });
  }
}

function syncSelectedRoleFromDevice() {
  const status = getDeviceRoleStatus();
  if (!status.valid) return;
  state.selectedRole = status.deviceRole;
  renderRoles();
  updateHelloPreview();
  saveState();
}

function valueFrom(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function renderTemplateOptions() {
  const previous = dom.templateSelect.value;
  dom.templateSelect.innerHTML = "";
  const entries = Object.entries(templates).sort(([, left], [, right]) => {
    const a = normalizeTemplate(left.id, left);
    const b = normalizeTemplate(right.id, right);
    const categoryCompare = String(a.category).localeCompare(String(b.category), "zh-CN");
    if (categoryCompare) return categoryCompare;
    return String(a.label).localeCompare(String(b.label), "zh-CN");
  });
  for (const [key, template] of entries) {
    const normalized = normalizeTemplate(key, template);
    const option = document.createElement("option");
    option.value = key;
    option.textContent = normalized.label.startsWith(normalized.category)
      ? normalized.label
      : `${normalized.category} · ${normalized.label}`;
    dom.templateSelect.appendChild(option);
  }
  if (previous && templates[previous]) {
    dom.templateSelect.value = previous;
  }
  refreshSelectControl(dom.templateSelect);
  updateProtocolTemplateControls();
}

function renderScenarioOptions() {
  const previous = dom.scenarioSelect.value;
  dom.scenarioSelect.innerHTML = "";
  const sorted = Object.values(scenarios).sort((a, b) => {
    const groupCompare = scenarioProductGroup(a).localeCompare(scenarioProductGroup(b), "zh-CN");
    if (groupCompare) return groupCompare;
    return String(a.label || a.id).localeCompare(String(b.label || b.id), "zh-CN");
  });
  for (const scenario of sorted) {
    const option = document.createElement("option");
    option.value = scenario.id;
    const group = scenarioProductGroup(scenario);
    option.textContent = `${group} · ${scenario.label || scenario.id}`;
    option.title = scenarioPurpose(scenario);
    dom.scenarioSelect.appendChild(option);
  }
  if (previous && scenarios[previous]) {
    dom.scenarioSelect.value = previous;
  } else if (scenarios["role-text-smoke"]) {
    dom.scenarioSelect.value = "role-text-smoke";
  }
  refreshSelectControl(dom.scenarioSelect);
  renderScenarioMeta();
}

function renderScenarioMeta() {
  if (!dom.scenarioMeta || !dom.scenarioSelect) return;
  const scenario = scenarios[dom.scenarioSelect.value] || scenarios["role-text-smoke"];
  if (!scenario) {
    dom.scenarioMeta.innerHTML = `<span>场景</span><strong>等待模块加载</strong>`;
    return;
  }
  const group = scenarioProductGroup(scenario);
  const stability = scenarioStability(scenario);
  const purpose = scenarioPurpose(scenario);
  const steps = scenarioStepSummary(scenario);
  const expected = scenarioExpectedEvidence(scenario);
  const precondition = scenarioPrecondition(scenario);
  const failureHint = scenarioFailureHint(scenario);
  dom.scenarioMeta.innerHTML = `
    <span>当前验收场景</span>
    <strong>${escapeHtml(scenario.label || scenario.id)}</strong>
    <p>${escapeHtml(purpose)}</p>
    <div class="meta-chip-row">
      <span class="meta-chip">${escapeHtml(group)}</span>
      <span class="meta-chip">${escapeHtml(stability)}</span>
      <span class="meta-chip">${escapeHtml(precondition)}</span>
      <span class="meta-chip">${escapeHtml(steps)}</span>
      <span class="meta-chip">${escapeHtml(expected)}</span>
      <span class="meta-chip">${escapeHtml(failureHint)}</span>
    </div>
  `;
  renderScenarioSteps(state.lastReport?.name === scenario.id ? state.lastReport.steps : []);
  renderInspectorContext();
}

function writeIdentityToInputs() {
  const identity = state.identity;
  dom.deviceIdInput.value = identity.deviceId;
  dom.userIdInput.value = identity.userId;
  dom.traceIdInput.value = identity.traceId;
  dom.clientIdInput.value = identity.clientId;
  dom.deviceMacInput.value = identity.deviceMac;
  dom.clientIpInput.value = identity.clientIp;
  dom.deviceNameInput.value = identity.deviceName;
  dom.tokenInput.value = identity.token;
  saveState();
}

function readIdentityFromInputs() {
  return {
    roleCode: inferRoleFromDeviceId(dom.deviceIdInput.value),
    deviceId: dom.deviceIdInput.value.trim(),
    userId: dom.userIdInput.value.trim(),
    traceId: dom.traceIdInput.value.trim(),
    clientId: dom.clientIdInput.value.trim(),
    deviceMac: dom.deviceMacInput.value.trim(),
    clientIp: dom.clientIpInput.value.trim(),
    deviceName: dom.deviceNameInput.value.trim(),
    token: dom.tokenInput.value.trim()
  };
}

function buildHello() {
  const identity = readIdentityFromInputs();
  const frameDuration = Number(dom.frameDurationInput.value);
  const sampleRate = Number(dom.sampleRateInput.value);
  const format = dom.audioFormatInput.value;
  const audioParams = {
    format,
    sample_rate: sampleRate,
    channels: 1,
    frame_duration: frameDuration
  };
  const base = {
    type: "hello",
    version: 1,
    transport: "websocket",
    device_id: identity.deviceId,
    user_id: identity.userId,
    trace_id: identity.traceId,
    client_ip: identity.clientIp,
    audio_params: audioParams
  };

  if (dom.helloClientIdInput.checked) base.client_id = identity.clientId;
  if (dom.helloTokenToggle.checked) base.token = identity.token;
  if (dom.helloDeviceNameToggle.checked) base.device_name = identity.deviceName;
  if (dom.helloDeviceMacToggle.checked) base.device_mac = identity.deviceMac;
  if (dom.helloPlaybackToggle.checked) {
    base.playback_audio_params = {
      format: dom.playbackFormatInput.value,
      sample_rate: Number(dom.playbackSampleRateInput.value),
      channels: 1,
      frame_duration: Number(dom.playbackFrameDurationInput.value)
    };
  }
  if (dom.helloFeaturesToggle.checked) {
    base.features = parseJsonObject(dom.helloFeaturesInput.value, "features");
  }
  if (dom.helloLocationToggle.checked) {
    base.location = {
      longitude: numberFromInput(dom.helloLongitudeInput, 120.123456),
      latitude: numberFromInput(dom.helloLatitudeInput, 30.123456),
      address: dom.helloAddressInput.value.trim() || "杭州市西湖区",
      ad_code: dom.helloAdCodeInput.value.trim() || "330106"
    };
  }
  if (dom.helloClientInfoToggle.checked) {
    base.client_info = {
      os_type: dom.helloOsTypeInput.value.trim() || "Web",
      os_version: navigator.platform || "browser",
      app_version: dom.helloAppVersionInput.value.trim() || "ws-lab",
      network_type: dom.helloNetworkTypeInput.value.trim() || "wifi",
      network_provider: "local",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      country_code: "CN",
      battery_level: Math.max(0, Math.min(100, numberFromInput(dom.helloBatteryInput, 76))),
      is_charging: true
    };
  }
  if (dom.helloSessionToggle.checked && dom.helloSessionInput.value.trim()) {
    base.session_id = dom.helloSessionInput.value.trim();
  }
  if (dom.sleepModeInput.checked) {
    base.sleep_mode = true;
  }

  const extraText = dom.helloExtraInput.value.trim();
  const extra = extraText ? JSON.parse(extraText) : {};
  const merged = deepMerge(base, extra);
  merged.type = "hello";
  merged.version = 1;
  merged.transport = "websocket";
  merged.device_id = identity.deviceId;
  merged.user_id = identity.userId;
  merged.trace_id = identity.traceId;
  merged.client_ip = identity.clientIp;
  merged.audio_params = audioParams;
  return merged;
}

function parseJsonObject(text, label) {
  const value = JSON.parse(text || "{}");
  if (!isPlainObject(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value;
}

function numberFromInput(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function updateHelloPreview() {
  dom.helloExtraInput.classList.remove("invalid");
  dom.helloFeaturesInput.classList.remove("invalid");
  try {
    const hello = buildHello();
    const conflicts = getHelloExtraConflicts(hello);
    dom.helloPreview.textContent = JSON.stringify(hello, null, 2);
    if (dom.helloDialog.open) {
      dom.helloDialogPreview.textContent = dom.helloPreview.textContent;
    }
    dom.helloValidity.textContent = `合法 · 角色 ${hello.device_id.slice(2, 4)}`;
    dom.helloConflictLabel.textContent = conflicts.length ? `覆盖 ${conflicts.join(", ")}` : "无覆盖";
    dom.helloConflictLabel.style.color = conflicts.length ? "var(--orange)" : "";
    dom.helloValidity.style.color = "";
    dom.helloPreview.closest(".preview-card").classList.remove("invalid");
    updateClientPanelState({ valid: true, stale: conflicts.length > 0, text: dom.helloValidity.textContent });
  } catch (error) {
    dom.helloValidity.textContent = error.message;
    dom.helloConflictLabel.textContent = "JSON 异常";
    dom.helloConflictLabel.style.color = "var(--red)";
    dom.helloValidity.style.color = "var(--red)";
    if (error.message.startsWith("features")) {
      dom.helloFeaturesInput.classList.add("invalid");
    } else {
      dom.helloExtraInput.classList.add("invalid");
    }
    dom.helloPreview.closest(".preview-card").classList.add("invalid");
    updateClientPanelState({ valid: false, stale: false, text: error.message });
  }
}

function updateClientPanelState(helloStatus = null) {
  const identityStatus = updateIdentityStatus();
  const audioStatus = updateAudioProfileStatus();
  const identity = readIdentityFromInputsSafe();

  dom.clientSummaryRole.textContent = `角色 ${state.selectedRole}`;
  dom.clientSummaryRole.dataset.tone = !identityStatus.valid ? "invalid" : identityStatus.mismatch ? "stale" : "";
  dom.clientSummaryDevice.textContent = shortText(identity.deviceId || "device -");
  dom.clientSummaryUser.textContent = shortText(identity.userId || "user -");
  dom.clientSummaryAudio.textContent = formatAudioProfile(getDraftAudioProfileSafe());
  dom.clientSummaryAudio.dataset.tone = audioStatus.stale ? "stale" : "";
  dom.clientSummaryHello.textContent = helloStatus?.valid === false ? "Hello 异常" : "Hello 合法";
  dom.clientSummaryHello.dataset.tone = helloStatus?.valid === false ? "invalid" : helloStatus?.stale ? "stale" : "";

  setTabMarker(dom.identityClientTab, !identityStatus.valid ? "invalid" : identityStatus.mismatch ? "stale" : "");
  setTabMarker(dom.audioClientTab, audioStatus.stale ? "stale" : "");
  setTabMarker(dom.helloClientTab, helloStatus?.valid === false ? "invalid" : helloStatus?.stale ? "stale" : "");
  if (dom.advancedClientTab) {
    setTabMarker(dom.advancedClientTab, helloStatus?.valid === false ? "invalid" : "");
  }
  if (dom.topIdentitySummary) {
    dom.topIdentitySummary.textContent = `角色 ${state.selectedRole} · ${shortText(identity.deviceId || "device")}`;
    dom.topIdentitySummary.title = `${identity.deviceId || ""} · ${identity.userId || ""}`;
  }
  if (dom.topAudioSummary) {
    dom.topAudioSummary.textContent = formatAudioProfile(getDraftAudioProfileSafe());
    dom.topAudioSummary.dataset.tone = audioStatus.stale ? "stale" : "";
  }
  renderInspectorContext();
}

function updateIdentityStatus() {
  if (!dom.deviceIdInput) return { valid: true, mismatch: false, deviceRole: state.selectedRole };
  const status = getDeviceRoleStatus();
  dom.syncRoleFromDeviceBtn.hidden = true;
  dom.identityStatusBanner.dataset.tone = "ok";
  if (!status.valid) {
    dom.identityStatusText.textContent = `设备 ID 第 3/4 位为 ${status.raw || "空"}，未映射到 01-06`;
    dom.identityStatusBanner.dataset.tone = "invalid";
  } else if (status.mismatch) {
    dom.identityStatusText.textContent = `设备 ID 映射为角色 ${status.deviceRole}，当前选择为 ${state.selectedRole}`;
    dom.identityStatusBanner.dataset.tone = "stale";
    dom.syncRoleFromDeviceBtn.hidden = false;
    dom.syncRoleFromDeviceBtn.textContent = `切换到 ${status.deviceRole}`;
  } else {
    dom.identityStatusText.textContent = `角色与设备 ID 匹配：${status.deviceRole}`;
  }
  dom.identityRoleHint.textContent = status.valid
    ? `Device 第 3/4 位 = ${status.deviceRole}`
    : "Device 第 3/4 位需为 01-06";
  return status;
}

function getDeviceRoleStatus() {
  const raw = String(dom.deviceIdInput?.value || "").slice(2, 4);
  const valid = ROLE_CODES.includes(raw);
  return {
    raw,
    valid,
    deviceRole: valid ? raw : "",
    mismatch: valid && raw !== state.selectedRole
  };
}

function updateAudioProfileStatus() {
  const draft = getDraftAudioProfileSafe();
  const active = state.activeAudioProfile;
  const stale = Boolean(wsClient.isConnected && active && !profilesEqual(draft, active));
  dom.draftAudioProfileLabel.textContent = formatAudioProfile(draft);
  dom.activeAudioProfileLabel.textContent = active ? formatAudioProfile(active) : "未连接";
  dom.audioDraftStateLabel.textContent = stale ? "需要重连" : active ? "已生效" : "下一次握手生效";
  dom.audioReconnectNotice.textContent = stale
    ? "音频配置已变更，请断开重连，让 Hello 与推流配置保持一致。"
    : "音频配置将在下一次 Hello 握手中生效。";
  dom.audioReconnectNotice.dataset.tone = stale ? "stale" : "ok";
  return { stale };
}

function getDraftAudioProfileSafe() {
  if (!dom.audioFormatInput) return { format: "opus", sampleRate: 24000, frameDuration: 60 };
  return getDraftAudioProfile();
}

function formatAudioProfile(profile) {
  if (!profile) return "未连接";
  return `${profile.format}/${profile.sampleRate}/${profile.frameDuration}ms`;
}

function setTabMarker(tab, marker) {
  if (!tab) return;
  if (marker) {
    tab.dataset.marker = marker;
  } else {
    delete tab.dataset.marker;
  }
}

async function copyHelloJson() {
  try {
    const hello = buildHello();
    await navigator.clipboard.writeText(JSON.stringify(hello, null, 2));
    store.add({ direction: "system", type: "report", label: "已复制 Hello", payload: { fields: Object.keys(hello).length } });
  } catch (error) {
    store.add({ direction: "system", type: "error", error: `Hello JSON 无法复制: ${error.message}` });
  }
}

function openHelloDialog() {
  try {
    dom.helloDialogPreview.textContent = JSON.stringify(buildHello(), null, 2);
    if (typeof dom.helloDialog.showModal === "function") {
      dom.helloDialog.showModal();
    } else {
      dom.helloDialog.setAttribute("open", "");
    }
  } catch (error) {
    store.add({ direction: "system", type: "error", error: `Hello JSON 无法展开: ${error.message}` });
  }
}

function resetHelloOptions() {
  dom.helloClientIdInput.checked = true;
  dom.helloTokenToggle.checked = true;
  dom.helloDeviceNameToggle.checked = true;
  dom.helloDeviceMacToggle.checked = true;
  dom.helloPlaybackToggle.checked = true;
  dom.helloFeaturesToggle.checked = true;
  dom.helloLocationToggle.checked = false;
  dom.helloClientInfoToggle.checked = false;
  dom.helloSessionToggle.checked = false;
  dom.helloSessionInput.value = "";
  dom.helloFeaturesInput.value = '{"mcp":true,"ws_lab":true}';
  dom.helloLongitudeInput.value = "120.123456";
  dom.helloLatitudeInput.value = "30.123456";
  dom.helloAddressInput.value = "杭州市西湖区";
  dom.helloAdCodeInput.value = "330106";
  dom.helloOsTypeInput.value = "Web";
  dom.helloAppVersionInput.value = "ws-lab";
  dom.helloNetworkTypeInput.value = "wifi";
  dom.helloBatteryInput.value = "76";
  dom.helloExtraInput.value = "";
  updateHelloPreview();
  saveState();
  store.add({ direction: "system", type: "lab", label: "Hello 已重置为默认能力" });
}

function applyAudioPreset(value) {
  const [format, sampleRate, frameDuration] = String(value || "").split(":");
  if (!format || !sampleRate || !frameDuration) return;
  dom.audioFormatInput.value = format;
  dom.sampleRateInput.value = sampleRate;
  dom.frameDurationInput.value = frameDuration;
  dom.playbackFormatInput.value = format;
  dom.playbackSampleRateInput.value = sampleRate;
  dom.playbackFrameDurationInput.value = frameDuration;
  refreshSelectControls(dom.audioClientPanel);
  updateHelloPreview();
  saveState();
}

async function connectAndHello() {
  try {
    await openWsAndSendHello();
  } catch (error) {
    store.add({ direction: "system", type: "error", error: error.message });
    updateConnectionState("error");
  }
}

async function openWsAndSendHello() {
  const identity = readIdentityFromInputs();
  const wsUrl = normalizeWsInput(dom.wsUrlInput.value);
  const restBase = normalizeRestInput(dom.restBaseInput.value);
  assertEndpointCompatibleWithPage(wsUrl, restBase);
  downlinkAudioPlayer?.clear("connect", { keepUnlocked: true });
  await wsClient.connect(wsUrl, identity);
  wsClient.sendJson(buildHello());
  state.activeAudioProfile = getDraftAudioProfile();
  state.activePlaybackProfile = getDraftPlaybackProfile();
  updateClientPanelState({ valid: true, stale: false, text: dom.helloValidity.textContent });
  saveState();
}

function sendText() {
  try {
    const text = dom.textMessageInput.value.trim();
    if (!text) return;
    wsClient.sendTextListen(text, wsClient.sessionId);
    rememberExpectedInputText(text, 8000);
    dom.textMessageInput.value = "";
    autoResizeComposer();
  } catch (error) {
    store.add({ direction: "system", type: "error", error: error.message });
  }
}

function handleTextComposerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendText();
}

function updateCustomTemplate() {
  const template = normalizeTemplate(dom.templateSelect.value, templates[dom.templateSelect.value] ?? templates.listen_mode_start);
  const payload = withSession(createTemplatePayload(template), template);
  state.templateDraft = structuredClone(payload);
  renderTemplateMeta(template);
  renderTemplateParamForm(template, state.templateDraft);
  syncCustomJsonFromTemplateDraft();
  updateProtocolTemplateControls(template);
}

function formatCustomJson() {
  try {
    const payload = JSON.parse(dom.customJsonInput.value);
    dom.customJsonInput.value = JSON.stringify(payload, null, 2);
    dom.customJsonInput.classList.remove("invalid");
    state.templateDraft = structuredClone(payload);
    const template = normalizeTemplate(dom.templateSelect.value, templates[dom.templateSelect.value] ?? templates.listen_mode_start);
    renderTemplateParamForm(template, state.templateDraft);
  } catch (error) {
    dom.customJsonInput.classList.add("invalid");
    store.add({ direction: "system", type: "error", error: `JSON 无效: ${error.message}` });
  }
}

function sendCustomJson() {
  try {
    const payload = JSON.parse(dom.customJsonInput.value);
    const template = normalizeTemplate(dom.templateSelect.value, templates[dom.templateSelect.value] ?? templates.listen_mode_start);
    if (template.requires_session !== false && !wsClient.sessionId && payload.type !== "hello") {
      throw new Error("当前模板需要会话，请先完成 Hello 握手");
    }
    wsClient.sendJson(withSession(payload, template));
    dom.customJsonInput.classList.remove("invalid");
  } catch (error) {
    dom.customJsonInput.classList.add("invalid");
    store.add({ direction: "system", type: "error", error: error.message });
  }
}

function updateProtocolTemplateControls(template = null) {
  if (!dom.protocolTemplateNameInput) return;
  const normalized = template || normalizeTemplate(dom.templateSelect.value, templates[dom.templateSelect.value] ?? templates.listen_mode_start);
  const isCustom = String(normalized.id || "").startsWith(CUSTOM_TEMPLATE_PREFIX) || Boolean(templates[normalized.id]?.custom);
  dom.protocolTemplateNameInput.value = normalized.label || "";
  dom.deleteProtocolTemplateBtn.disabled = !isCustom;
  dom.deleteProtocolTemplateBtn.title = isCustom ? "删除当前自定义模板" : "内置模板不能删除";
}

function saveProtocolTemplate() {
  try {
    const payload = JSON.parse(dom.customJsonInput.value);
    if (!isPlainObject(payload) || !payload.type) {
      throw new Error("协议模板 payload 必须是包含 type 的 JSON object");
    }
    const currentId = dom.templateSelect.value;
    const existing = state.customProtocolTemplates.find((item) => item.id === currentId);
    const id = existing?.id || `${CUSTOM_TEMPLATE_PREFIX}${Date.now().toString(36)}`;
    const sourceTemplate = normalizeTemplate(currentId, templates[currentId] ?? {});
    const item = {
      id,
      label: (dom.protocolTemplateNameInput.value.trim() || sourceTemplate.label || payload.type).slice(0, 60),
      category: existing?.category || "自定义",
      requires_session: sourceTemplate.requires_session !== false,
      payload,
      params: inferTemplateParams(payload),
      expect: sourceTemplate.expect || [],
      custom: true
    };
    if (existing) {
      Object.assign(existing, item);
    } else {
      state.customProtocolTemplates.push(item);
    }
    templates[id] = item;
    renderTemplateOptions();
    dom.templateSelect.value = id;
    refreshSelectControl(dom.templateSelect);
    updateCustomTemplate();
    saveState();
    store.add({ direction: "system", type: "protocol", label: "自定义协议模板已保存", payload: { id, label: item.label } });
  } catch (error) {
    dom.customJsonInput.classList.add("invalid");
    store.add({ direction: "system", type: "error", error: `保存协议模板失败: ${error.message}` });
  }
}

function deleteProtocolTemplate() {
  const id = dom.templateSelect.value;
  const existing = state.customProtocolTemplates.find((item) => item.id === id);
  if (!existing) {
    store.add({ direction: "system", type: "protocol", error: "只能删除自定义协议模板" });
    return;
  }
  state.customProtocolTemplates = state.customProtocolTemplates.filter((item) => item.id !== id);
  delete templates[id];
  renderTemplateOptions();
  dom.templateSelect.value = templates.listen_manual_detect ? "listen_manual_detect" : Object.keys(templates)[0];
  refreshSelectControl(dom.templateSelect);
  updateCustomTemplate();
  saveState();
  store.add({ direction: "system", type: "protocol", label: "自定义协议模板已删除", payload: { id } });
}

async function exportProtocolTemplate() {
  try {
    const template = normalizeTemplate(dom.templateSelect.value, templates[dom.templateSelect.value] ?? {});
    const safe = {
      id: template.id,
      label: dom.protocolTemplateNameInput.value.trim() || template.label,
      category: template.category,
      requires_session: template.requires_session,
      payload: JSON.parse(dom.customJsonInput.value),
      params: inferTemplateParams(JSON.parse(dom.customJsonInput.value)),
      expect: template.expect || []
    };
    await navigator.clipboard.writeText(JSON.stringify(safe, null, 2));
    store.add({ direction: "system", type: "protocol", label: "协议模板已导出", payload: { id: safe.id } });
  } catch (error) {
    store.add({ direction: "system", type: "error", error: `导出协议模板失败: ${error.message}` });
  }
}

function importProtocolTemplate() {
  try {
    const raw = dom.protocolImportInput.value.trim();
    if (!raw) throw new Error("请先粘贴协议模板 JSON");
    const parsed = JSON.parse(raw);
    const payload = isPlainObject(parsed.payload) ? parsed.payload : parsed;
    if (!isPlainObject(payload) || !payload.type) {
      throw new Error("导入内容必须是协议 payload，或包含 payload 的模板对象");
    }
    const item = {
      id: `${CUSTOM_TEMPLATE_PREFIX}${Date.now().toString(36)}`,
      label: String(parsed.label || parsed.name || payload.type).slice(0, 60),
      category: String(parsed.category || "自定义"),
      requires_session: parsed.requires_session !== false,
      payload,
      params: Array.isArray(parsed.params) ? parsed.params : inferTemplateParams(payload),
      expect: Array.isArray(parsed.expect) ? parsed.expect : [],
      custom: true
    };
    state.customProtocolTemplates.push(item);
    templates[item.id] = item;
    renderTemplateOptions();
    dom.templateSelect.value = item.id;
    dom.protocolImportInput.value = "";
    dom.protocolImportInput.classList.remove("invalid");
    refreshSelectControl(dom.templateSelect);
    updateCustomTemplate();
    saveState();
    store.add({ direction: "system", type: "protocol", label: "协议模板已导入", payload: { id: item.id } });
  } catch (error) {
    dom.protocolImportInput.classList.add("invalid");
    store.add({ direction: "system", type: "error", error: `导入协议模板失败: ${error.message}` });
  }
}

function withSession(payload, template = null) {
  const next = resolvePayloadPlaceholders({ ...payload });
  const requiresSession = template?.requires_session !== false;
  if (requiresSession && wsClient.sessionId && !next.session_id && next.type !== "hello") {
    next.session_id = wsClient.sessionId;
  }
  return next;
}

function renderTemplateMeta(template) {
  const expects = (template.expect || []).map((item) => item.state ? `${item.type}:${item.state}` : item.type).filter(Boolean);
  dom.templateMeta.innerHTML = `
    <span>${escapeHtml(template.requires_session === false ? "无需会话" : "需要会话")}</span>
    <span>${escapeHtml(expects.length ? `期望 ${expects.join(", ")}` : "无固定期望")}</span>
  `;
}

function renderTemplateParamForm(template, payload) {
  const fields = getTemplateFields(template, payload);
  dom.templateParamForm.innerHTML = fields.map((field) => `
    <label>
      <span>${escapeHtml(field.label || displayParamPath(field.path))}</span>
      <input data-param-path="${escapeHtml(field.path)}" data-param-type="${escapeHtml(field.type || typeof field.value)}" value="${escapeHtml(String(field.value ?? ""))}" spellcheck="false" placeholder="${escapeHtml(field.description || field.options?.join(" / ") || "")}">
    </label>
  `).join("");
  for (const input of dom.templateParamForm.querySelectorAll("input[data-param-path]")) {
    input.addEventListener("input", () => {
      const path = input.dataset.paramPath;
      const current = getPathValue(state.templateDraft, path);
      setPathValue(state.templateDraft, path, coerceParamValue(input.value, current, input.dataset.paramType));
      syncCustomJsonFromTemplateDraft();
    });
  }
}

function syncCustomJsonFromTemplateDraft() {
  dom.customJsonInput.value = JSON.stringify(state.templateDraft || {}, null, 2);
  dom.customJsonInput.classList.remove("invalid");
}

function resolvePayloadPlaceholders(payload) {
  const identity = readIdentityFromInputs();
  return JSON.parse(JSON.stringify(payload)
    .replaceAll("{{session_id}}", wsClient.sessionId || "")
    .replaceAll("{{device_id}}", identity.deviceId)
    .replaceAll("{{user_id}}", identity.userId)
    .replaceAll("{{trace_id}}", identity.traceId));
}

async function checkHealth() {
  return probeEnvironmentCapabilities({ silent: false, force: true });
}

function createDefaultCapabilities(status = "unknown") {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, {
    status,
    message: capabilityDefaultMessage(key, status),
    checkedAt: ""
  }]));
}

function capabilityDefaultMessage(key, status) {
  if (status === "checking") return "检查中";
  if (status === "ok") return "可用";
  if (status === "missing") return "未部署";
  if (status === "forbidden") return "无权限";
  if (status === "error") return "异常";
  return ({
    rest: "REST 未检查",
    personalities: "角色配置未检查",
    logs: "日志未检查",
    rounds: "轮次未检查",
    logDetail: "原始证据未检查",
    tts: "TTS 懒探测",
    scenarioEvidence: "场景证据未检查"
  })[key] || "未检查";
}

function capability(key, status, message = "") {
  return {
    status,
    message: message || capabilityDefaultMessage(key, status),
    checkedAt: new Date().toLocaleTimeString("zh-CN", { hour12: false })
  };
}

function scheduleCapabilityProbe(delayMs = 500) {
  window.clearTimeout(capabilityProbeTimer);
  capabilityProbeTimer = window.setTimeout(() => {
    probeEnvironmentCapabilities({ silent: true, force: true });
  }, delayMs);
}

async function probeEnvironmentCapabilities({ silent = true, force = false } = {}) {
  const probeId = ++state.capabilityProbeId;
  const next = {
    ...createDefaultCapabilities("checking"),
    tts: state.capabilities?.tts?.status === "ok" ? state.capabilities.tts : capability("tts", "unknown", "TTS 懒探测")
  };
  commitCapabilities(next, { healthPayload: state.healthStatus.payload, preserveCheckedAt: true });

  let healthPayload = null;
  try {
    healthPayload = await api.health();
    if (probeId !== state.capabilityProbeId) return state.capabilities;
    next.rest = capability("rest", "ok", "REST 正常");
    applyServerCapabilities(next, healthPayload.capabilities);
  } catch (error) {
    if (probeId !== state.capabilityProbeId) return state.capabilities;
    const restStatus = statusFromApiError(error);
    next.rest = capability("rest", restStatus, restCapabilityErrorMessage(error, restStatus));
    for (const key of REST_DEPENDENT_CAPABILITIES) {
      next[key] = capability(key, restStatus === "forbidden" ? "forbidden" : "missing", "依赖 dev REST，当前不可用");
    }
    commitCapabilities(next, { healthPayload: null });
    if (!silent) {
      store.add({ direction: "system", type: "rest", error: next.rest.message });
    }
    setEndpointDialogStatus(`REST 检查失败: ${next.rest.message}`, "error");
    return next;
  }

  const probes = [];
  if (shouldProbeCapability(healthPayload, ["personalities"], "personalities")) {
    probes.push(probeCapability("personalities", () => api.personalities()));
  }
  if (shouldProbeCapability(healthPayload, ["logs"], "logs")) {
    probes.push(probeCapability("logs", () => api.logsSummary({ limit: 1 })));
  }
  if (shouldProbeCapability(healthPayload, ["rounds"], "rounds")) {
    probes.push(probeCapability("rounds", () => api.logRounds({ limit: 1 })));
  }
  const checks = await Promise.allSettled(probes);
  if (probeId !== state.capabilityProbeId) return state.capabilities;

  for (const result of checks) {
    if (result.status === "fulfilled") {
      next[result.value.key] = result.value.capability;
      if (result.value.key === "personalities" && result.value.payload) {
        state.personalities = result.value.payload;
        renderPersonalityHints();
      }
    } else {
      const key = result.reason?.key || "rest";
      next[key] = result.reason?.capability || capability(key, "error", result.reason?.message || "探测失败");
    }
  }

  if (!healthPayload?.capabilities?.log_detail) {
    next.logDetail = next.logs.status === "ok"
      ? capability("logDetail", "ok", "原始证据可用")
      : capability("logDetail", next.logs.status, "依赖日志接口");
  }
  if (next.tts.status === "checking") {
    next.tts = capability("tts", "unknown", "TTS 懒探测");
  }
  next.scenarioEvidence = next.logs.status === "ok"
    ? capability("scenarioEvidence", next.rounds.status === "ok" ? "ok" : "missing", next.rounds.status === "ok" ? "场景证据完整" : "缺少轮次证据")
    : capability("scenarioEvidence", next.logs.status, "缺少日志证据");

  commitCapabilities(next, { healthPayload });
  if (!silent) {
    store.add({ direction: "system", type: "rest", label: "能力探测", payload: exportCapabilities() });
  }
  setEndpointDialogStatus(capabilitySummaryText(), state.capabilities.rest.status === "ok" ? "ok" : "error");
  if (force) {
    refreshActiveInspectorView();
  }
  return next;
}

function setHealthStatus({ rest = state.healthStatus.rest, message = state.healthStatus.message, payload = null } = {}) {
  state.healthStatus = {
    rest,
    message,
    checkedAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    payload
  };
  renderHealthStatus();
  renderOverview();
}

async function probeCapability(key, fn) {
  try {
    const payload = await fn();
    return {
      key,
      payload,
      capability: capability(key, "ok", capabilityOkMessage(key, payload))
    };
  } catch (error) {
    throw {
      key,
      capability: capability(key, statusFromApiError(error), capabilityErrorMessage(key, error)),
      message: error.message,
      error
    };
  }
}

function applyServerCapabilities(target, capabilities = {}) {
  if (!capabilities || typeof capabilities !== "object") return;
  const map = {
    rest: "rest",
    personalities: "personalities",
    logs: "logs",
    rounds: "rounds",
    log_detail: "logDetail",
    logDetail: "logDetail",
    tts: "tts",
    scenario_evidence: "scenarioEvidence",
    scenarioEvidence: "scenarioEvidence"
  };
  for (const [rawKey, rawValue] of Object.entries(capabilities)) {
    const key = map[rawKey];
    if (!key) continue;
    const ok = rawValue === true || rawValue === "ok";
    if (key === "tts" && ok) {
      target[key] = capability("tts", "unknown", "TTS 懒探测");
      continue;
    }
    target[key] = capability(key, ok ? "ok" : "missing", ok ? capabilityOkMessage(key) : capabilityDefaultMessage(key, "missing"));
  }
}

function shouldProbeCapability(healthPayload, aliases, key) {
  const capabilities = healthPayload?.capabilities;
  if (!capabilities || typeof capabilities !== "object") return true;
  const explicit = aliases.find((alias) => Object.prototype.hasOwnProperty.call(capabilities, alias));
  if (!explicit) return true;
  const value = capabilities[explicit];
  if (value === false || value === "missing" || value === "forbidden" || value === "error") return false;
  return targetCapabilityStatus(value, key) === "ok";
}

function targetCapabilityStatus(value, key) {
  if (key === "tts" && value === true) return "unknown";
  return value === true || value === "ok" ? "ok" : "missing";
}

function commitCapabilities(next, { healthPayload = null, preserveCheckedAt = false } = {}) {
  state.capabilities = normalizeCapabilities(next);
  state.environmentCapability = classifyEnvironmentCapability(state.capabilities);
  const rest = state.capabilities.rest;
  state.healthStatus = {
    rest: rest.status,
    message: rest.message,
    checkedAt: preserveCheckedAt ? state.healthStatus.checkedAt : new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    payload: healthPayload
  };
  publishCapabilities();
  renderHealthStatus();
  applyCapabilityGates();
  renderOverview();
  renderInspectorContext();
}

function normalizeCapabilities(next = {}) {
  const normalized = createDefaultCapabilities();
  for (const key of CAPABILITY_KEYS) {
    normalized[key] = {
      ...normalized[key],
      ...(next[key] || {})
    };
  }
  return normalized;
}

function classifyEnvironmentCapability(capabilities = state.capabilities) {
  if (Object.values(capabilities).some((item) => item.status === "checking")) return "checking";
  if (capabilities.rest.status !== "ok") return "protocol-only";
  if (capabilities.logs.status === "ok" && capabilities.rounds.status === "ok") return "full";
  return "partial";
}

function publishCapabilities() {
  const exported = exportCapabilities();
  window.__WS_LAB_CAPABILITIES__ = exported;
  document.documentElement.dataset.environmentCapability = state.environmentCapability;
}

function exportCapabilities() {
  return {
    mode: state.environmentCapability,
    capabilities: Object.fromEntries(Object.entries(state.capabilities).map(([key, item]) => [key, {
      status: item.status,
      message: item.message,
      checked_at: item.checkedAt || ""
    }]))
  };
}

function statusFromApiError(error = {}) {
  if (error.status === 401 || error.status === 403) return "forbidden";
  if (error.status === 404) return "missing";
  return "error";
}

function restCapabilityErrorMessage(error, status) {
  if (status === "forbidden") return `REST 无权限: ${error.message}`;
  if (status === "missing") return `REST 未部署: ${error.message}`;
  return `REST 异常: ${error.message}`;
}

function capabilityErrorMessage(key, error) {
  const status = statusFromApiError(error);
  const name = capabilityName(key);
  if (status === "forbidden") return `${name}无权限`;
  if (status === "missing") return `${name}未部署`;
  return `${name}异常: ${error.message}`;
}

function capabilityOkMessage(key, payload = null) {
  if (key === "logs") return payload?.log_file ? `日志可读 · ${payload.log_file}` : "日志可读";
  if (key === "rounds") return payload?.summary?.round_count !== undefined ? `轮次可用 · ${payload.summary.round_count} 轮` : "轮次可用";
  return `${capabilityName(key)}可用`;
}

function capabilityName(key) {
  return ({
    rest: "REST",
    personalities: "角色配置",
    logs: "日志",
    rounds: "轮次",
    logDetail: "原始证据",
    tts: "TTS",
    scenarioEvidence: "场景证据"
  })[key] || key;
}

function capabilitySummaryText() {
  return ({
    full: "完整诊断可用",
    partial: "部分诊断可用",
    "protocol-only": "仅协议模式",
    checking: "能力检查中",
    error: "诊断异常"
  })[state.environmentCapability] || "能力未知";
}

function renderHealthStatus() {
  if (dom.endpointHealthStatus) {
    dom.endpointHealthStatus.textContent = `${state.healthStatus.message}${state.healthStatus.checkedAt ? ` · ${state.healthStatus.checkedAt}` : ""}`;
    dom.endpointHealthStatus.dataset.state = state.healthStatus.rest;
  }
  if (dom.capabilityPill) {
    dom.capabilityPill.dataset.state = state.environmentCapability;
    dom.capabilityPill.textContent = capabilitySummaryText();
    dom.capabilityPill.title = capabilityDetailText();
  }
}

function applyCapabilityGates() {
  const restOk = isCapabilityOk("rest");
  const logsOk = isCapabilityOk("logs");
  const roundsOk = isCapabilityOk("rounds");
  const checking = state.environmentCapability === "checking";
  const ttsBlocked = !restOk || ["missing", "forbidden", "error"].includes(state.capabilities.tts.status);

  setSoftDisabled(dom.openInspectorDrawerBtn, !restOk, inspectorUnavailableReason());
  setTabAvailability(dom.roundTab, roundsOk, roundsOk ? "" : capabilityUnavailableText("rounds"));
  setTabAvailability(dom.logsTab, logsOk, logsOk ? "" : capabilityUnavailableText("logs"));
  setTabAvailability(dom.scenarioTab, restOk, restOk ? "" : capabilityUnavailableText("scenarioEvidence"));

  if (!checking && !roundsOk && dom.roundView && !dom.roundView.hidden) {
    activateInspectorTab("overviewView");
  }
  if (!checking && !logsOk && dom.logsView && !dom.logsView.hidden) {
    activateInspectorTab("overviewView");
  }
  if (!checking && !restOk && dom.scenarioView && !dom.scenarioView.hidden) {
    activateInspectorTab("overviewView");
  }

  setHardDisabled(dom.refreshRoundsBtn, !roundsOk, capabilityUnavailableText("rounds"));
  setHardDisabled(dom.roundSessionSelect, !roundsOk, capabilityUnavailableText("rounds"));
  setHardDisabled(dom.refreshLogsBtn, !logsOk, capabilityUnavailableText("logs"));
  setHardDisabled(dom.runScenarioBtn, !restOk, restOk ? "" : "当前为仅协议模式，UI 场景证据不可用；URL 自动化会生成 degraded/blocked 报告。");
  setHardDisabled(dom.generateTtsBtn, ttsBlocked, ttsBlocked ? capabilityUnavailableText("tts") : "");
}

function isCapabilityOk(key) {
  return state.capabilities?.[key]?.status === "ok";
}

function setSoftDisabled(element, disabled, reason = "") {
  if (!element) return;
  element.setAttribute("aria-disabled", String(disabled));
  element.classList.toggle("soft-disabled", Boolean(disabled));
  element.title = disabled ? reason : "";
}

function setHardDisabled(element, disabled, reason = "") {
  if (!element) return;
  element.disabled = Boolean(disabled);
  element.title = disabled ? reason : "";
}

function setTabAvailability(tab, available, reason = "") {
  if (!tab) return;
  tab.setAttribute("aria-disabled", String(!available));
  tab.classList.toggle("soft-disabled", !available);
  tab.title = available ? "" : reason;
}

function activateInspectorTab(targetId) {
  if (!dom.inspectorTabs) return;
  activateTab(dom.inspectorTabs, targetId);
}

function capabilityUnavailableText(key) {
  const item = state.capabilities?.[key];
  if (!item || item.status === "unknown" || item.status === "checking") return `${capabilityName(key)}仍在检查`;
  return item.message || `${capabilityName(key)}不可用`;
}

function inspectorUnavailableReason() {
  if (state.environmentCapability === "checking") return "诊断能力正在检查";
  if (state.capabilities.rest.status === "forbidden") return "诊断不可用：目标环境拒绝当前客户端访问 dev REST";
  if (state.capabilities.rest.status === "missing") return "诊断不可用：目标环境未部署 /api/v1/dev/ws-lab";
  return "诊断不可用：目标环境 REST 地址不可达或异常";
}

function capabilityDetailText() {
  return CAPABILITY_KEYS
    .map((key) => `${capabilityName(key)}: ${state.capabilities[key]?.message || capabilityDefaultMessage(key, "unknown")}`)
    .join("\n");
}

function markCapabilityFromError(key, error) {
  const next = normalizeCapabilities(state.capabilities);
  next[key] = capability(key, statusFromApiError(error), capabilityErrorMessage(key, error));
  if (key === "logs") {
    next.scenarioEvidence = capability("scenarioEvidence", next[key].status, "缺少日志证据");
  }
  if (key === "rounds" && next.logs.status === "ok") {
    next.scenarioEvidence = capability("scenarioEvidence", "missing", "缺少轮次证据");
  }
  commitCapabilities(next, { healthPayload: state.healthStatus.payload });
}

function markCapabilityOk(key, message = "") {
  const next = normalizeCapabilities(state.capabilities);
  next[key] = capability(key, "ok", message || capabilityOkMessage(key));
  commitCapabilities(next, { healthPayload: state.healthStatus.payload });
}

async function loadPersonalities() {
  try {
    state.personalities = await api.personalities();
    renderPersonalityHints();
  } catch (error) {
    store.add({ direction: "system", type: "rest", error: `角色配置未加载: ${error.message}` });
  }
}

async function loadModules() {
  try {
    const snapshot = await moduleHost.load();
    state.moduleSnapshot = snapshot;
    for (const action of snapshot.actions) {
      templates[action.id] = normalizeTemplate(action.id, action);
    }
    for (const scenario of snapshot.scenarios) {
      scenarios[scenario.id] = scenario;
    }
    renderTemplateOptions();
    renderScenarioOptions();
    renderModules(snapshot);
    renderScenarioMeta();
    updateCustomTemplate();
    refreshSelectControls();
  } catch (error) {
    store.add({ direction: "system", type: "module", error: error.message });
  }
}

function renderModules(snapshot) {
  const rows = snapshot.modules.map((item) => ({
    ...item,
    status: "已加载",
    domain: moduleDomain(item),
    actionCount: snapshot.actions.filter((action) => action.moduleId === item.id).length,
    scenarioCount: snapshot.scenarios.filter((scenario) => scenario.moduleId === item.id).length
  }));
  const groups = groupBy(rows, (item) => item.domain);
  dom.moduleList.innerHTML = Object.entries(groups).map(([domain, items]) => `
    <section class="module-group">
      <div class="module-group-title">
        <span>${escapeHtml(domain)}</span>
        <span>${items.length} 模块</span>
      </div>
      ${items.map((item) => `
        <div class="module-row">
          <span class="module-main">
            <strong>${escapeHtml(item.name || item.id)}</strong>
            <em>${escapeHtml(moduleCoverageText(item))}</em>
          </span>
          <span class="status-pill pass">${escapeHtml(item.status)}</span>
        </div>
      `).join("")}
    </section>
  `).join("") + renderMissingCoverage(snapshot);
  const errors = snapshot.errors || [];
  const productErrors = errors.filter((item) => !isBuiltInDiagnosticSample(item));
  const sampleErrors = errors.filter(isBuiltInDiagnosticSample);
  if (productErrors.length) {
    dom.moduleDiagnostics.innerHTML = renderDiagnosticDetails("模块诊断", productErrors, "已隔离", true);
  } else if (sampleErrors.length) {
    dom.moduleDiagnostics.innerHTML = renderDiagnosticDetails("开发诊断", sampleErrors.map((item) => ({
      ...item,
      message: "内置异常样例：缺少 id 或 name，已隔离，不影响正常验收"
    })), "样例", false);
  } else {
    dom.moduleDiagnostics.innerHTML = `<div class="module-diagnostics-empty">无模块诊断</div>`;
  }
}

function renderDiagnosticDetails(title, items, status, open) {
  return `
    <details ${open ? "open" : ""}>
      <summary>${escapeHtml(title)} · ${items.length} 项</summary>
      ${items.map((item) => `
        <div class="module-row diagnostic">
          <span class="module-main"><strong>${escapeHtml(item.id)}</strong><em>${escapeHtml(item.message)}</em></span>
          <span class="status-pill muted">${escapeHtml(status)}</span>
        </div>
      `).join("")}
    </details>
  `;
}

function isBuiltInDiagnosticSample(item) {
  return item?.id === "invalid-sample";
}

function renderPersonalityHints() {
  const roleMap = state.personalities?.role_personality_map ?? {};
  const personalityId = roleMap[state.selectedRole] || "unmapped";
  dom.identityRoleHint.textContent = `角色 ${state.selectedRole} -> ${personalityId}`;
}

async function refreshLogs(options = {}) {
  if (state.logPaused && !options.force) return;
  if (!isCapabilityOk("logs")) {
    renderLogUnavailable(capabilityUnavailableText("logs"));
    return;
  }
  try {
    const filters = buildLogFilters();
    const [insights, evidence] = await Promise.all([
      api.logInsights({ ...filters, limit: 120 }),
      api.logsSummary(filters)
    ]);
    renderLogInsights(insights);
    renderLogEvidence(evidence);
    renderChainTimeline();
    if (!options.silent) {
      store.add({ direction: "system", type: "rest", label: "日志洞察", payload: insights.summary });
    }
  } catch (error) {
    markCapabilityFromError("logs", error);
    dom.logSummary.textContent = error.message;
    store.add({ direction: "system", type: "rest", error: error.message });
  }
}

async function refreshRounds(options = {}) {
  if (state.roundPaused && !options.force) return;
  if (!isCapabilityOk("rounds")) {
    renderRoundUnavailable(capabilityUnavailableText("rounds"));
    return;
  }
  try {
    await refreshRoundSessions(options);
    const filters = buildRoundFilters();
    const data = await api.logRounds({ ...filters, limit: 100 });
    renderRounds(data, options);
    if (!options.silent) {
      store.add({ direction: "system", type: "rest", label: "轮次叙事", payload: data.summary });
    }
  } catch (error) {
    markCapabilityFromError("rounds", error);
    dom.roundSummary.innerHTML = [
      renderRoundSummaryChip("状态", "轮次接口不可用", true),
      renderRoundSummaryChip("原因", error.message, false, "wide")
    ].join("");
    dom.roundList.innerHTML = `<div class="round-empty">当前 REST 服务还没有返回轮次聚合数据。重启后端后会使用新的 /logs/rounds 接口。</div>`;
    dom.roundDetail.innerHTML = `<div class="round-empty">轮次叙事等待后端聚合接口。原始日志仍可在“日志”tab 查看。</div>`;
    store.add({ direction: "system", type: "rest", error: error.message });
  }
}

function renderLogUnavailable(reason) {
  if (dom.logSummary) {
    dom.logSummary.textContent = `日志不可用：${reason}`;
  }
  if (dom.logInsightList) {
    dom.logInsightList.innerHTML = `<div class="round-empty">当前环境没有可用日志洞察。${escapeHtml(reason)}</div>`;
  }
  renderChainTimeline();
}

function renderRoundUnavailable(reason) {
  if (dom.roundSummary) {
    dom.roundSummary.innerHTML = [
      renderRoundSummaryChip("状态", "轮次不可用", true),
      renderRoundSummaryChip("原因", reason, false, "wide")
    ].join("");
  }
  if (dom.roundList) {
    dom.roundList.innerHTML = `<div class="round-empty">当前环境没有可用轮次聚合。${escapeHtml(reason)}</div>`;
  }
  if (dom.roundDetail) {
    dom.roundDetail.innerHTML = `<div class="round-empty">轮次叙事需要目标环境提供 /logs/rounds。</div>`;
  }
}

async function refreshRoundSessions(options = {}) {
  const filters = buildRoundSessionFilters();
  const data = await api.logSessions({ ...filters, limit: 40 });
  const sessions = data.sessions ?? [];
  state.roundSessions = sessions;
  if (!state.selectedSessionId || options.forceSession) {
    state.selectedSessionId = pickDefaultSessionId(sessions);
  } else if (!sessions.some((item) => sessionOptionValue(item) === state.selectedSessionId)) {
    const current = wsClient.sessionId || "";
    state.selectedSessionId = current && sessions.some((item) => sessionOptionValue(item) === current)
      ? current
      : pickDefaultSessionId(sessions);
  }
  renderRoundSessionSelect(sessions);
}

function pickDefaultSessionId(sessions = []) {
  const current = wsClient.sessionId || "";
  if (current && sessions.some((item) => sessionOptionValue(item) === current)) {
    return current;
  }
  return sessionOptionValue(sessions[0]) || current || "";
}

function toggleLogPause() {
  state.logPaused = !state.logPaused;
  dom.pauseLogsBtn.textContent = state.logPaused ? "继续" : "暂停";
  dom.pauseLogsBtn.setAttribute("aria-pressed", String(state.logPaused));
  if (!state.logPaused) {
    refreshLogs({ force: true });
  }
}

async function runSmokeScenario() {
  dom.runScenarioBtn.disabled = true;
  dom.scenarioReport.className = "scenario-report";
  const scenario = scenarios[dom.scenarioSelect.value] || scenarios["role-text-smoke"];
  dom.scenarioReport.textContent = `正在运行 ${scenario.id}...`;
  try {
    await probeEnvironmentCapabilities({ silent: true, force: true });
    if (!scenario.builtin && scenario.auto_connect !== false && !wsClient.isConnected) {
      await connectAndHello();
      await waitForActiveSession();
    }
    const report = scenario.builtin
      ? await scenarioRunner.runRoleTextSmoke(normalizeWsInput(dom.wsUrlInput.value), readIdentityFromInputs())
      : await scenarioRunner.runDslScenario(scenario);
    report.ws_session_id = wsClient.sessionId;
    report.binary_metrics = store.summary();
    report.environment_capabilities = exportCapabilities();
    state.lastReport = report;
    window.__WS_LAB_LAST_REPORT__ = report;
    document.documentElement.dataset.scenarioStatus = scenarioDatasetStatus(report);
    renderScenarioReport(report);
  } catch (error) {
    const blocked = !wsClient.isConnected && !scenario.builtin;
    const report = {
      ok: false,
      blocked,
      status: blocked ? "blocked" : "fail",
      name: scenario.id,
      durationMs: 0,
      steps: [],
      error: error.message,
      ws_session_id: wsClient.sessionId,
      binary_metrics: store.summary(),
      environment_capabilities: exportCapabilities()
    };
    state.lastReport = report;
    window.__WS_LAB_LAST_REPORT__ = report;
    document.documentElement.dataset.scenarioStatus = scenarioDatasetStatus(report);
    renderScenarioReport(report);
  } finally {
    dom.runScenarioBtn.disabled = false;
    applyCapabilityGates();
  }
}

function waitForActiveSession(timeoutMs = 12000) {
  if (wsClient.sessionId) return Promise.resolve(wsClient.sessionId);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error(`等待 hello session 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = store.subscribe((event) => {
      if (!event) return;
      if (wsClient.sessionId || (event.payload?.type === "hello" && event.payload.session_id)) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(wsClient.sessionId || event.payload.session_id);
      }
    });
  });
}

async function copyReport(format) {
  if (!state.lastReport) {
    store.add({ direction: "system", type: "report", error: "还没有可导出的场景报告" });
    return;
  }
  const safeReport = sanitizeReport(state.lastReport);
  const text = format === "json" ? JSON.stringify(safeReport, null, 2) : reportToMarkdown(safeReport);
  await navigator.clipboard.writeText(text);
  store.add({ direction: "system", type: "report", label: `copied ${format}`, payload: { format } });
}

async function copySelectedScenario() {
  const scenario = scenarios[dom.scenarioSelect.value];
  if (!scenario) return;
  await navigator.clipboard.writeText(JSON.stringify(scenario, null, 2));
  store.add({ direction: "system", type: "scenario", label: "copied scenario", payload: { id: scenario.id } });
}

function importScenario() {
  try {
    const scenario = JSON.parse(dom.scenarioImportInput.value);
    if (!scenario.id || !scenario.label || !Array.isArray(scenario.steps)) {
      throw new Error("场景必须包含 id、label 和 steps[]");
    }
    scenarios[scenario.id] = { ...scenario, area: scenario.area || "Imported" };
    renderScenarioOptions();
    dom.scenarioSelect.value = scenario.id;
    dom.scenarioImportInput.value = "";
    store.add({ direction: "system", type: "scenario", label: "imported", payload: { id: scenario.id } });
  } catch (error) {
    store.add({ direction: "system", type: "scenario", error: error.message });
  }
}

function reportToMarkdown(report) {
  const status = scenarioDatasetStatus(report);
  const lines = [
    `# WS Lab 验收报告`,
    ``,
    `- 场景: ${displayScenarioName(report.name)}`,
    `- 结果: ${({ pass: "通过", degraded: "降级通过", blocked: "阻塞", fail: "失败" })[status] || status}`,
    `- 耗时: ${report.durationMs}ms`,
    `- 会话: ${report.ws_session_id || ""}`,
    `- 音频帧: ${JSON.stringify(report.binary_metrics || {})}`,
    `- 环境能力: ${state.environmentCapability}`,
    ``,
    `## 步骤`
  ];
  for (const step of report.steps || []) {
    lines.push(`- ${displayStatus(step.status)}: ${displayStepName(step.name)}${step.note ? ` (${step.note})` : ""}`);
  }
  if (report.error) {
    lines.push("", "## 异常", report.error);
  }
  if (report.evidence) {
    lines.push("", "## 证据", "```json", JSON.stringify(report.evidence, null, 2), "```");
  }
  return lines.join("\n");
}

function sanitizeReport(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReport(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    safe[key] = isSensitiveReportKey(key) ? "[redacted]" : sanitizeReport(entry);
  }
  return safe;
}

function isSensitiveReportKey(key) {
  return /token|secret|authorization|provider.*key|api[_-]?key|password|prompt/i.test(key);
}

async function streamSelectedWav() {
  const file = dom.wavFileInput.files?.[0];
  if (!file) {
    store.add({ direction: "system", type: "audio", error: "请选择 WAV 文件" });
    return;
  }
  await runAudioAction(async () => {
    if (wsClient.isConnected) {
      const profile = ensureActiveAudioProfile();
      addAudioInputCue({
        source: "wav",
        label: "客户端 WAV",
        text: `${file.name} · ${formatAudioProfile(profile)} · 等待 ASR 识别`
      });
    }
    await audioStreamer.streamFile(file);
  });
}

function applyScenarioAudioProfile(profile = {}) {
  if (profile.format) dom.audioFormatInput.value = profile.format;
  if (profile.sample_rate || profile.sampleRate) dom.sampleRateInput.value = String(profile.sample_rate || profile.sampleRate);
  if (profile.frame_duration || profile.frameDuration) dom.frameDurationInput.value = String(profile.frame_duration || profile.frameDuration);
  state.activeAudioProfile = getDraftAudioProfile();
  updateHelloPreview();
  refreshSelectControls();
  saveState();
}

function markScenarioHelloSent() {
  state.activeAudioProfile = getDraftAudioProfile();
  state.activePlaybackProfile = getDraftPlaybackProfile();
  updateClientPanelState({ valid: true, stale: false, text: dom.helloValidity.textContent });
  saveState();
}

async function streamScenarioSilence(durationMs) {
  audioStreamer.startSilence();
  await delay(durationMs);
  audioStreamer.stop();
  const profile = ensureActiveAudioProfile();
  await delay(profile.frameDuration + 120);
}

async function streamScenarioGeneratedTts(text, options = {}) {
  const profile = ensureActiveAudioProfile();
  const requestedText = String(text || "").trim();
  if (!requestedText) {
    throw new Error("stream_tts text is required");
  }

  audioStreamer.reserve("generating");
  let data;
  try {
    data = await api.tts({
      text: requestedText,
      sample_rate: profile.sampleRate,
      duration_ms: Number(options.duration_ms || options.durationMs || 1400)
    });
    markCapabilityOk("tts", data?.speech ? "真实 TTS 可用" : "TTS 测试音可用");
  } catch (error) {
    markCapabilityFromError("tts", error);
    throw error;
  } finally {
    audioStreamer.releaseReservation();
  }

  if (!data?.no_secrets) {
    throw new Error("TTS endpoint did not confirm no_secrets");
  }
  if (options.require_speech !== false && !data.speech) {
    throw new Error("TTS endpoint returned local tone; ASR nostream scenario requires speech=true");
  }

  store.add({
    direction: "system",
    type: "audio",
    label: data.speech ? "真实 TTS 已生成" : "本地测试音已生成",
    payload: {
      provider: data.provider,
      format: data.format,
      mime_type: data.mime_type,
      bytes: data.bytes,
      speech: Boolean(data.speech),
      compatibility: data.compatibility
    }
  });
  addAudioInputCue({
    source: data.speech ? "generated" : "tone",
    label: data.speech ? "客户端 生成语音" : "客户端 测试音",
    text: data.speech ? requestedText : "本地测试音已推流，等待传输链路反馈"
  });
  if (data.speech) {
    rememberExpectedInputText(requestedText, 45000);
  }

  const blob = base64ToBlob(data.audio_base64, data.mime_type);
  await audioStreamer.streamBlob(blob, data.provider || "tts");
  return data;
}

async function generateAndStreamTts() {
  if (!isCapabilityOk("rest") || ["missing", "forbidden", "error"].includes(state.capabilities.tts.status)) {
    showCapabilityNotice("生成语音不可用", capabilityUnavailableText("tts"));
    store.add({ direction: "system", type: "audio", error: capabilityUnavailableText("tts") });
    return;
  }
  await runAudioAction(async () => {
    const profile = ensureActiveAudioProfile();
    const requestedText = dom.ttsTextInput.value.trim();
    audioStreamer.reserve("generating");
    let data;
    try {
      try {
        data = await api.tts({
          text: requestedText,
          sample_rate: profile.sampleRate,
          duration_ms: 1400
        });
        markCapabilityOk("tts", data?.speech ? "真实 TTS 可用" : "TTS 测试音可用");
      } catch (error) {
        markCapabilityFromError("tts", error);
        throw error;
      }
    } finally {
      audioStreamer.releaseReservation();
    }
    if (!data?.no_secrets) {
      throw new Error("TTS endpoint did not confirm no_secrets");
    }
    store.add({
      direction: "system",
      type: "audio",
      label: data.speech ? "真实 TTS 已生成" : "本地测试音已生成",
      payload: {
        provider: data.provider,
        format: data.format,
        mime_type: data.mime_type,
        bytes: data.bytes,
        speech: Boolean(data.speech),
        compatibility: data.compatibility
      }
    });
    if (!data.speech) {
      dom.audioStateLabel.textContent = "传输音";
    }
    if (data.speech && requestedText) {
      addAudioInputCue({
        source: "generated",
        label: "客户端 生成语音",
        text: requestedText
      });
      rememberExpectedInputText(requestedText, 45000);
    } else {
      addAudioInputCue({
        source: "tone",
        label: "客户端 测试音",
        text: "本地测试音已推流，等待传输链路反馈"
      });
    }
    const blob = base64ToBlob(data.audio_base64, data.mime_type);
    await audioStreamer.streamBlob(blob, data.provider || "tts");
  });
}

async function startMicInput() {
  await runAudioAction(async () => {
    await audioStreamer.startMic();
    addAudioInputCue({
      source: "mic",
      label: "客户端 麦克风",
      text: "全双工麦克风输入中，等待 ASR 识别"
    });
  });
}

async function toggleMicInput() {
  if (audioStreamer?.mode === "mic") {
    audioStreamer.stop();
    updateMicButtonState("idle");
    return;
  }
  await startMicInput();
}

function updateMicButtonState(value = audioStreamer?.mode || "idle") {
  const active = value === "mic";
  for (const button of [dom.startMicBtn, dom.audioMicBtn]) {
    if (!button) continue;
    const idleLabel = button.dataset.idleLabel || "全双工";
    const activeLabel = button.dataset.activeLabel || "停止";
    button.dataset.active = String(active);
    button.textContent = active ? activeLabel : idleLabel;
    button.title = active ? "停止麦克风全双工推流" : "点击开启麦克风全双工推流";
  }
}

function addAudioInputCue({ source, label, text }) {
  store.add({
    direction: "client",
    type: "audio_input",
    label,
    payload: {
      source,
      label,
      text,
      session_id: wsClient.sessionId || ""
    }
  });
}

function rememberExpectedInputText(text, ttlMs = 45000) {
  const normalized = normalizeConversationText(text);
  if (!normalized) return;
  const now = Date.now();
  state.pendingExpectedInputTexts = state.pendingExpectedInputTexts
    .filter((item) => now - item.at < item.ttlMs && item.text !== normalized);
  state.pendingExpectedInputTexts.push({ text: normalized, at: now, ttlMs });
}

function consumeExpectedInputText(text) {
  const normalized = normalizeConversationText(text);
  if (!normalized) return false;
  const now = Date.now();
  let matched = false;
  state.pendingExpectedInputTexts = state.pendingExpectedInputTexts.filter((item) => {
    const fresh = now - item.at < item.ttlMs;
    if (fresh && item.text === normalized && !matched) {
      matched = true;
      return false;
    }
    return fresh;
  });
  return matched;
}

async function runAudioAction(action) {
  try {
    await action();
  } catch (error) {
    store.add({ direction: "system", type: "audio", error: error.message });
    dom.audioStateLabel.textContent = "异常";
  }
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildLogFilters() {
  const filters = buildIdentityLogFilters();
  const scope = dom.logScopeSelect?.value || "session";
  if (scope === "global") {
    delete filters.device_id;
    delete filters.user_id;
    delete filters.session_id;
    delete filters.trace_id;
  } else if (scope === "trace") {
    delete filters.device_id;
    delete filters.user_id;
    delete filters.session_id;
  } else if (scope === "device") {
    delete filters.user_id;
    delete filters.session_id;
    delete filters.trace_id;
  } else if (scope === "user") {
    delete filters.device_id;
    delete filters.session_id;
    delete filters.trace_id;
  } else if (scope === "session") {
    if (!filters.session_id) {
      delete filters.session_id;
    }
  }
  if (dom.logLevelSelect?.value) filters.level = dom.logLevelSelect.value;
  if (dom.logPhaseSelect?.value) filters.phase = dom.logPhaseSelect.value;
  if (dom.logSinceSelect?.value) filters.since = dom.logSinceSelect.value;
  if (dom.logTurnInput?.value.trim()) filters.turn_id = dom.logTurnInput.value.trim();
  if (dom.logErrorOnlyInput?.checked) filters.error_only = "1";
  return filters;
}

function buildRoundFilters() {
  const filters = {
    session_id: state.selectedSessionId || dom.roundSessionSelect?.value || wsClient.sessionId || ""
  };
  if (!filters.session_id) {
    Object.assign(filters, buildRoundSessionFilters());
  }
  if (dom.roundErrorOnlyInput?.checked) filters.error_only = "1";
  filters.include_missing = dom.roundMissingInput?.checked ? "1" : "0";
  filters.include_unknown = dom.roundUnknownInput?.checked ? "1" : "0";
  return filters;
}

function buildRoundSessionFilters() {
  const identity = readIdentityFromInputsSafe();
  return {
    device_id: identity.deviceId || "",
    user_id: identity.userId || ""
  };
}

function buildIdentityLogFilters() {
  return {
    device_id: dom.deviceIdInput.value.trim(),
    user_id: dom.userIdInput.value.trim(),
    session_id: wsClient.sessionId,
    trace_id: dom.traceIdInput.value.trim(),
    keyword: dom.logKeywordInput?.value.trim() || ""
  };
}

function renderLogInsights(data) {
  const summary = data.summary ?? {};
  const insights = [...(data.insights ?? [])].reverse();
  state.logInsights = insights;
  dom.logSummary.innerHTML = [
    `<strong>${summary.total_matched ?? 0}</strong> 条匹配`,
    `<span>扫描 ${summary.total_scanned ?? 0} 条</span>`,
    `<span>${data.log_file ?? "server.log"}</span>`,
    state.logPaused ? `<span>已暂停刷新</span>` : `<span>自动刷新中</span>`
  ].join(" · ");

  if (!insights.length) {
    dom.logInsightList.innerHTML = `<div class="log-insight-card"><span>日志洞察</span><p class="log-insight-summary">当前筛选条件下没有匹配日志。</p></div>`;
    return;
  }

  dom.logInsightList.innerHTML = groupLogInsights(insights).map((group) => `
    <section class="log-insight-group">
      <div class="log-insight-group-title">
        <strong>${escapeHtml(group.label)}</strong>
        <span>${group.items.length} 条</span>
      </div>
      ${group.items.map(({ item, index }) => renderLogInsightCard(item, index)).join("")}
    </section>
  `).join("");
  renderOverview();
}

function groupLogInsights(insights = []) {
  const priority = ["错误", "ASR", "输入", "监听", "意图", "工具", "LLM", "TTS", "延迟", "持久化", "状态", "输出", "Hello", "连接", "日志"];
  const groups = new Map();
  insights.forEach((item, index) => {
    const label = item.severity === "error" || item.phase === "错误" ? "错误" : item.phase || "日志";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ item, index });
  });
  return [...groups.entries()]
    .sort(([left], [right]) => (priority.indexOf(left) === -1 ? 999 : priority.indexOf(left)) - (priority.indexOf(right) === -1 ? 999 : priority.indexOf(right)))
    .map(([label, items]) => ({ label, items }));
}

function renderLogInsightCard(item, index) {
  return `
    <button type="button" class="log-insight-card" data-log-index="${index}" data-testid="log-insight-card">
      <div class="log-insight-head">
        <span class="phase-pill" data-severity="${escapeHtml(item.severity || item.level || "info")}">${escapeHtml(item.phase || "日志")}</span>
        <strong class="log-insight-title">${escapeHtml(item.title || item.msg || "日志事件")}</strong>
        <span>${escapeHtml(formatInsightTime(item.time))}</span>
      </div>
      <p class="log-insight-summary">${escapeHtml(item.summary || item.raw_preview || "查看原始日志详情")}</p>
      <div class="log-chip-row">${logInsightChips(item).map((chip) => `<span class="log-chip">${escapeHtml(chip)}</span>`).join("")}</div>
    </button>
  `;
}

function renderLogEvidence(evidence) {
  const findings = (evidence.findings ?? []).map((item) => `${item.severity}:${item.code}`).join(" · ");
  dom.logSummary.innerHTML += `<br><span>${escapeHtml(findings || "暂无异常发现")}</span>`;
  renderOverview();
}

function renderRounds(data = {}, options = {}) {
  const rounds = data.rounds ?? [];
  state.rounds = rounds;
  state.roundSummary = data.summary ?? {};
  state.roundLogFile = data.log_file || "server.log";
  const previous = state.selectedRoundId;
  const latest = rounds[0] || null;
  const shouldFollow = dom.roundFollowLatestInput?.checked || options.followLatest;
  const selected = shouldFollow
    ? latest
    : rounds.find((round) => round.id === previous) || latest;
  state.selectedRoundId = selected?.id || "";
  state.hasNewRounds = Boolean(selected && latest && selected.id !== latest.id);
  renderRoundSummary(data.summary, selected, data.log_file);
  renderRoundList(rounds, selected);
  renderRoundDetail(selected);
  renderOverview();
}

function renderRoundSessionSelect(sessions = []) {
  if (!dom.roundSessionSelect) return;
  if (!sessions.length) {
    dom.roundSessionSelect.innerHTML = `<option value="">等待可读会话</option>`;
    dom.roundSessionSelect.value = "";
    refreshSelectControl(dom.roundSessionSelect);
    return;
  }
  dom.roundSessionSelect.innerHTML = sessions.map((session) => {
    const value = sessionOptionValue(session);
    return `<option value="${escapeHtml(value)}">${escapeHtml(sessionOptionLabel(session))}</option>`;
  }).join("");
  dom.roundSessionSelect.value = state.selectedSessionId || sessionOptionValue(sessions[0]);
  refreshSelectControl(dom.roundSessionSelect);
}

function sessionOptionValue(session = {}) {
  return session.session_id || session.id || "";
}

function sessionOptionLabel(session = {}) {
  const status = displayRoundStatus(session.status || "unknown");
  const rounds = `${session.round_count || 0}轮`;
  const user = shortText(session.user_id || session.device_id || session.trace_id || "unknown");
  const time = formatInsightTime(session.time_end || session.time_start);
  const current = wsClient.sessionId && sessionOptionValue(session) === wsClient.sessionId ? "当前" : time;
  return `${current} · ${rounds} · ${status} · ${user}`;
}

function renderRoundSummary(summary = {}, selected, logFile) {
  const sessionLabel = selected?.session_id || state.selectedSessionId || "未选择会话";
  dom.roundSummary.innerHTML = [
    renderRoundSummaryChip("轮次", summary.round_count ?? 0, true),
    renderRoundSummaryChip("扫描", `${summary.total_scanned ?? 0} 条`),
    renderRoundSummaryChip("缺失", summary.missing_count ?? 0),
    renderRoundSummaryChip("其他", summary.unknown_count ?? 0),
    renderRoundSummaryChip("会话", shortText(sessionLabel), false, "wide"),
    state.hasNewRounds ? renderRoundSummaryChip("提示", "有新轮次", true) : "",
    renderRoundSummaryChip("日志", logFile || "server.log"),
    selected
      ? renderRoundSummaryChip("当前", roundTitle(selected), false, "wide")
      : renderRoundSummaryChip("状态", "等待轮次证据", false, "wide")
  ].filter(Boolean).join("");
}

function renderRoundSummaryChip(label, value, prominent = false, className = "") {
  const classes = ["round-summary-chip", prominent ? "prominent" : "", className].filter(Boolean).join(" ");
  return `
    <span class="${classes}">
      <b>${escapeHtml(label)}</b>
      <em>${escapeHtml(String(value ?? ""))}</em>
    </span>
  `;
}

function renderRoundList(rounds, selected) {
  if (!rounds.length) {
    dom.roundList.innerHTML = `<div class="round-empty">当前筛选条件下没有可读轮次。先运行一轮对话，或切到全局范围查看历史日志。</div>`;
    return;
  }
  dom.roundList.innerHTML = rounds.map((round, index) => `
    <button type="button" class="round-row ${selected?.id === round.id ? "active" : ""}" data-round-index="${index}" data-testid="round-row">
      <span class="phase-pill" data-severity="${escapeHtml(roundSeverity(round))}">${escapeHtml(displayRoundStatus(round.status))}</span>
      <strong>${escapeHtml(roundTitle(round))}</strong>
      <em>${escapeHtml(roundPreview(round))}</em>
      <small>${escapeHtml(roundMetricPreview(round))}</small>
    </button>
  `).join("");
}

function renderRoundDetail(round) {
  if (!round) {
    dom.roundDetail.innerHTML = `<div class="round-empty">等待日志形成可读轮次。这里会显示输入、EOU、意图、模型、TTS、延迟和其他模块。</div>`;
    state.roundDetailCards = [];
    return;
  }
  const cards = fixedRoundCards(round);
  state.roundDetailCards = cards;
  dom.roundDetail.innerHTML = `
    <div class="round-hero">
      <div>
        <span>输入</span>
        <strong>${escapeHtml(roundInputText(round))}</strong>
      </div>
      <div>
        <span>时间</span>
        <strong>${escapeHtml(formatRoundRange(round))}</strong>
      </div>
      <div>
        <span>证据</span>
        <strong>${escapeHtml(`${round.evidence?.raw_count ?? 0} 条 · 缺失 ${round.evidence?.missing_count ?? 0}`)}</strong>
      </div>
    </div>
    <section class="round-section">
      <h3>固定叙事</h3>
      <div class="round-card-list">
        ${cards.map((card, index) => renderRoundCard(card, round, index)).join("")}
      </div>
    </section>
  `;
}

function renderRoundCard(card, round, cardIndex) {
  const facts = roundDisplayFacts(card).slice(0, 6);
  const missing = card.missing ?? [];
  const evidence = card.evidence ?? [];
  return `
    <button type="button" class="round-card" data-round-card-index="${cardIndex}" data-status="${escapeHtml(card.status || "")}" data-testid="round-card">
      <div class="round-card-head">
        <span class="phase-pill" data-severity="${escapeHtml(card.severity || roundSeverity(round))}">${escapeHtml(displayRoundStatus(card.status))}</span>
        <strong>${escapeHtml(card.title || card.module || "模块事件")}</strong>
        <em>${escapeHtml(roundImpactLabel(card.impact || card.module))}</em>
      </div>
      <p>${escapeHtml(card.summary || "已收纳相关模块证据。")}</p>
      ${facts.length ? `<div class="round-facts">${facts.map((fact) => `
        <span><b>${escapeHtml(fact.label)}</b>${escapeHtml(previewInline(fact.value, 88))}</span>
      `).join("")}</div>` : ""}
      ${missing.length ? `<div class="round-missing">${missing.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${evidence.length ? `<div class="round-evidence">${evidence.slice(0, 4).map((item) => `
        <span data-round-line="${escapeHtml(item.line_no)}">line ${escapeHtml(item.line_no)} · ${escapeHtml(item.phase || item.title || "日志")}</span>
      `).join("")}</div>` : ""}
    </button>
  `;
}

function fixedRoundCards(round = {}) {
  const sourceCards = round.cards || [];
  const used = new Set();
  return fixedRoundNarrativeCards.map((definition) => {
    const matched = sourceCards.filter((card, index) => {
      if (!definition.modules.includes(card.module)) return false;
      if (definition.categories?.length) {
        const evidenceMatch = (card.evidence || []).some((item) => definition.categories.includes(item.category));
        const factMatch = (card.facts || []).some((fact) => {
          const label = String(fact.label || "").toLowerCase();
          if (definition.key === "llm_request") return label.includes("请求");
          if (definition.key === "llm_response") return label.includes("响应") || label.includes("tokens");
          return false;
        });
        if (!evidenceMatch && !factMatch) return false;
      }
      used.add(index);
      return true;
    });
    return buildFixedRoundCard(definition, matched, round);
  }).map((card) => {
    if (card.key !== "persistence") return card;
    const leftovers = sourceCards.filter((_, index) => !used.has(index));
    if (!leftovers.length) return card;
    return mergeFixedRoundCard(card, leftovers, "未归属证据");
  });
}

function buildFixedRoundCard(definition, matched, round) {
  const required = definition.required || (definition.requiredForAudio && round.input?.mode === "audio");
  if (!matched.length) {
    return {
      id: `${round.id || "round"}-${definition.key}`,
      key: definition.key,
      round: round.round,
      section: "固定叙事",
      module: definition.key,
      title: definition.title,
      status: required ? "missing" : "idle",
      severity: required ? "warning" : "info",
      impact: required ? "missing_evidence" : "not_triggered",
      summary: definition.empty,
      facts: [],
      evidence: [],
      missing: required ? [definition.empty] : []
    };
  }
  return mergeFixedRoundCard({
    id: `${round.id || "round"}-${definition.key}`,
    key: definition.key,
    round: round.round,
    section: "固定叙事",
    module: definition.key,
    title: definition.title,
    status: "triggered",
    severity: "info",
    impact: matched[0].impact || definition.key,
    summary: "",
    facts: [],
    evidence: [],
    missing: []
  }, matched);
}

function mergeFixedRoundCard(base, matched, fallbackSummary = "") {
  const facts = [];
  const evidence = [];
  const missing = [];
  const summaries = [];
  let status = base.status;
  let severity = base.severity;
  for (const card of matched) {
    if (card.summary) summaries.push(card.summary);
    for (const fact of card.facts || []) {
      if (!facts.some((item) => item.label === fact.label && item.value === fact.value)) {
        facts.push(fact);
      }
    }
    for (const item of card.evidence || []) {
      if (!evidence.some((existing) => existing.line_no === item.line_no)) {
        evidence.push(item);
      }
    }
    for (const item of card.missing || []) {
      if (!missing.includes(item)) missing.push(item);
    }
    if (card.status === "failed" || card.severity === "error") {
      status = "failed";
      severity = "error";
    } else if ((card.status === "missing" || card.status === "partial" || card.severity === "warning") && severity !== "error") {
      status = card.status || "partial";
      severity = "warning";
    } else if (status === "idle" || status === "missing") {
      status = card.status || "triggered";
    }
  }
  return {
    ...base,
    status,
    severity,
    summary: summaries.length ? summaries.slice(0, 2).join(" · ") : fallbackSummary || base.summary,
    facts,
    evidence: evidence.sort((a, b) => Number(a.line_no || 0) - Number(b.line_no || 0)),
    missing
  };
}

function groupRoundCards(cards) {
  const groups = [
    { section: "核心链路", kind: "core", cards: [] },
    { section: "扩展模块", kind: "module", cards: [] },
    { section: "其他日志", kind: "other", cards: [] }
  ];
  for (const card of cards) {
    groups[roundCardGroupIndex(card)].cards.push(card);
  }
  return groups.filter((group) => group.cards.length);
}

function roundCardGroupIndex(card = {}) {
  const module = card.module || "";
  if (["input", "eou", "state_machine", "intent", "speculative", "llm", "tts", "latency", "persistence"].includes(module)) {
    return 0;
  }
  if (["speaker_verification", "moderation", "memory_recommendation", "tools", "pre_reply", "expression"].includes(module)) {
    return 1;
  }
  return 2;
}

function roundDisplayFacts(card = {}) {
  const hiddenLabels = new Set(["阶段", "来源", "类别"]);
  return (card.facts || []).filter((fact) => fact?.value && !hiddenLabels.has(fact.label));
}

function roundImpactLabel(value) {
  return ({
    user_input: "输入",
    turn_boundary: "判停",
    identity_gate: "身份",
    safety_gate: "安全",
    route_instruction: "路由",
    context_injection: "上下文",
    model_race: "投机",
    model_reply: "模型",
    external_action: "工具",
    first_response: "秒回",
    state_transition: "状态",
    expression_output: "动作",
    voice_output: "播报",
    latency_summary: "延迟",
    history_persistence: "历史",
    missing_evidence: "缺证据",
    interrupt: "打断",
    not_triggered: "未触发",
    observed: "观察",
    failure: "失败"
  })[value] || value || "";
}

function handleRoundSessionChange() {
  state.selectedSessionId = dom.roundSessionSelect?.value || "";
  state.selectedRoundId = "";
  refreshRounds({ force: true });
}

function handleRoundListClick(event) {
  const row = event.target.closest("[data-round-index]");
  if (!row) return;
  const round = state.rounds[Number(row.dataset.roundIndex)];
  if (!round) return;
  state.selectedRoundId = round.id;
  if (dom.roundFollowLatestInput) dom.roundFollowLatestInput.checked = false;
  state.hasNewRounds = Boolean(state.rounds[0] && state.rounds[0].id !== round.id);
  renderRoundSummary(state.roundSummary || {}, round, state.roundLogFile);
  renderRoundList(state.rounds, round);
  renderRoundDetail(round);
  renderOverview();
}

async function handleRoundDetailClick(event) {
  const line = event.target.closest("[data-round-line]");
  if (line) {
    event.stopPropagation();
    await openLogInsightDetail({ line_no: Number(line.dataset.roundLine), phase: "轮次", title: "轮次证据" });
    return;
  }
  const cardButton = event.target.closest("[data-round-card-index]");
  if (!cardButton) return;
  const card = state.roundDetailCards?.[Number(cardButton.dataset.roundCardIndex)];
  if (!card) return;
  openInspectorDetail({
    eyebrow: `${card.section || "轮次"} · ${card.module || ""}`,
    title: card.title || "轮次模块",
    meta: [
      `状态 ${displayRoundStatus(card.status)}`,
      card.impact ? `影响 ${card.impact}` : "",
      `${card.evidence?.length || 0} 条证据`
    ].filter(Boolean),
    body: card
  });
}

async function copyRoundReport(format) {
  const round = currentRound();
  if (!round) {
    store.add({ direction: "system", type: "round", error: "还没有可复制的轮次报告" });
    return;
  }
  const text = format === "json" ? JSON.stringify(round, null, 2) : roundToMarkdown(round);
  await navigator.clipboard.writeText(text);
  store.add({ direction: "system", type: "round", label: `copied ${format}`, payload: { round: round.round } });
}

function currentRound() {
  return state.rounds.find((round) => round.id === state.selectedRoundId) || state.rounds[0] || null;
}

function roundToMarkdown(round) {
  const lines = [
    `# WS Lab 轮次报告`,
    ``,
    `- 轮次: ${round.round}`,
    `- 状态: ${displayRoundStatus(round.status)}`,
    `- 会话: ${round.session_id || ""}`,
    `- 用户: ${round.user_id || ""}`,
    `- 输入: ${roundInputText(round)}`,
    `- 证据: ${round.evidence?.raw_count || 0} 条，缺失 ${round.evidence?.missing_count || 0}，其他 ${round.evidence?.unknown_count || 0}`,
    ``
  ];
  lines.push(`## 固定叙事`);
  for (const card of fixedRoundCards(round)) {
    lines.push(`- ${card.title}: ${card.summary || displayRoundStatus(card.status)}`);
    for (const fact of card.facts || []) {
      lines.push(`  - ${fact.label}: ${fact.value}`);
    }
    for (const missing of card.missing || []) {
      lines.push(`  - 缺失: ${missing}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderScenarioReport(report) {
  const status = scenarioDatasetStatus(report);
  dom.scenarioReport.className = `scenario-report ${status}`;
  const stepText = report.steps.map((step) => `${displayStepName(step.name)}:${displayStatus(step.status)}${step.note ? `(${step.note})` : ""}`).join("  ");
  const title = ({
    pass: "通过",
    fail: "失败",
    blocked: "阻塞",
    degraded: "降级通过"
  })[status] || "未知";
  dom.scenarioReport.innerHTML = `
    <strong>${title} · ${displayScenarioName(report.name)}</strong><br>
    <span>${report.durationMs}ms · ${escapeHtml(stepText)}</span>
    ${report.warnings?.length ? `<br><span>${escapeHtml(report.warnings.join("；"))}</span>` : ""}
    ${report.error ? `<br><span>${escapeHtml(report.error)}</span>` : ""}
  `;
  renderScenarioSteps(report.steps || []);
  renderScenarioMeta();
  renderInspectorContext();
}

function scenarioDatasetStatus(report) {
  if (report?.blocked || report?.status === "blocked") return "blocked";
  if (report?.degraded || report?.status === "degraded") return "degraded";
  return report?.ok ? "pass" : "fail";
}

function renderScenarioSteps(steps = []) {
  if (!dom.scenarioSteps) return;
  if (!steps.length) {
    dom.scenarioSteps.innerHTML = "";
    return;
  }
  dom.scenarioSteps.innerHTML = steps.map((step) => `
    <div class="scenario-step-row">
      <strong>${escapeHtml(displayStepName(step.name))}${step.note ? ` · ${escapeHtml(step.note)}` : ""}</strong>
      <span class="status-pill ${step.status === "pass" ? "pass" : step.status === "fail" ? "fail" : "warn"}">${escapeHtml(displayStatus(step.status))}</span>
    </div>
  `).join("");
}

function handleStoreUpdate(event) {
  handleDownlinkAudioEvent(event);
  renderMetrics();
  renderInspectorContext();
  renderChainTimeline();
  if (event) {
    appendConversation(event);
  }
}

function handleDownlinkAudioEvent(event) {
  if (!event || !downlinkAudioPlayer) return;
  if (event.direction === "server" && event.payload?.type === "hello") {
    applyPlaybackProfileFromHello(event.payload);
    return;
  }
  if (event.direction === "server" && event.payload?.type === "tts") {
    downlinkAudioPlayer.handleTtsEvent(event.payload);
    return;
  }
  if (event.direction === "server" && event.kind === "binary" && event.binaryPayload) {
    void downlinkAudioPlayer.enqueueFrame(event.binaryPayload);
    return;
  }
  if (event.direction === "client" && event.payload?.type === "interrupt") {
    downlinkAudioPlayer.clear("client_interrupt", { keepUnlocked: true, keepStats: true });
  }
}

async function handlePlaybackToggleAction() {
  try {
    const stats = downlinkAudioPlayer.stats();
    if (!stats.unlocked) {
      await downlinkAudioPlayer.unlock();
      store.add({ direction: "system", type: "audio_playback", label: "声音已开启" });
      return;
    }
    const muted = downlinkAudioPlayer.toggleMute();
    store.add({ direction: "system", type: "audio_playback", label: muted ? "下行声音已静音" : "下行声音已恢复" });
  } catch (error) {
    store.add({ direction: "system", type: "audio_playback", error: error.message });
  }
}

function updatePlaybackState(stats = downlinkAudioPlayer?.stats()) {
  if (!stats) return;
  const label = displayPlaybackState(stats);
  const actionText = playbackButtonText(stats);
  if (dom.playbackStateLabel) {
    dom.playbackStateLabel.textContent = actionText;
    dom.playbackStateLabel.dataset.state = stats.status;
    dom.playbackStateLabel.title = `${label} · ${playbackButtonTitle(stats)}`;
  }
  if (dom.playbackToggleBtn) {
    dom.playbackToggleBtn.dataset.state = stats.status;
    dom.playbackToggleBtn.textContent = actionText;
    dom.playbackToggleBtn.title = playbackButtonTitle(stats);
  }
  if (dom.metricPlayback) {
    dom.metricPlayback.textContent = `${stats.playedFrames}/${stats.droppedFrames}`;
    dom.metricPlayback.title = `收到 ${stats.receivedFrames} 帧/${stats.receivedBytes}B · 已播 ${stats.playedFrames} · 丢弃 ${stats.droppedFrames} · 队列 ${stats.queueDelayMs}ms`;
  }
}

function displayPlaybackState(stats = downlinkAudioPlayer?.stats()) {
  if (!stats) return "下行未开启";
  const statusMap = {
    locked: "下行未开启",
    ready: "声音已开",
    buffering: "下行缓冲中",
    playing: `播放中 ${stats.queueDelayMs}ms`,
    muted: "下行静音",
    error: "播放失败"
  };
  return statusMap[stats.status] || stats.status;
}

function playbackButtonTitle(stats) {
  if (!stats.unlocked) return "点击解锁浏览器音频播放";
  if (stats.muted) return "点击恢复下行音频播放";
  return "点击静音下行音频播放";
}

function playbackButtonText(stats) {
  if (!stats.unlocked) return "开启声音";
  if (stats.muted) return "取消静音";
  return "静音";
}

function renderMetrics() {
  const summary = store.summary();
  dom.metricEvents.textContent = summary.total;
  dom.metricServer.textContent = summary.server;
  dom.metricBinary.textContent = `${summary.binary}`;
  dom.metricBinary.title = `in ${summary.inboundBinary}/${summary.inboundBytes}B · out ${summary.outboundBinary}/${summary.outboundBytes}B`;
  updatePlaybackState();
  renderEvidenceCards(summary);
  renderOverview();
}

function renderOverview() {
  if (!dom.overviewSummary) return;
  const summary = store.summary();
  const playback = downlinkAudioPlayer?.stats();
  const roundSummary = state.roundSummary || {};
  const current = currentRound();
  const session = state.selectedSessionId || wsClient.sessionId || "";
  const connection = displayConnectionState(dom.connectionPill?.dataset.state || "idle");
  const latestRoundText = current
    ? `${displayRoundStatus(current.status)} · ${roundTitle(current)}`
    : "等待日志形成可读轮次";
  const bottlenecks = [];
  if (roundSummary.missing_count) bottlenecks.push(`缺失证据 ${roundSummary.missing_count}`);
  if (roundSummary.unknown_count) bottlenecks.push(`未归属 ${roundSummary.unknown_count}`);
  if (state.hasNewRounds) bottlenecks.push("有新轮次待查看");
  if (!bottlenecks.length) bottlenecks.push(summary.server ? "链路已有服务端反馈" : "等待服务端反馈");
  renderOverviewHealth(summary, current);
  dom.overviewSummary.innerHTML = `
    <strong>${escapeHtml(connection)} · ${escapeHtml(session ? shortText(session) : "未握手")}</strong>
    <span>${escapeHtml(latestRoundText)}</span>
    <span>${escapeHtml(bottlenecks.join(" · "))}</span>
    <span>${escapeHtml(`${summary.outboundBinary} 上行音频 / ${summary.inboundBinary} 下行音频 · ${displayPlaybackState(playback)}`)}</span>
  `;
  if (dom.overviewHints) {
    const next = current
      ? "打开轮次查看固定叙事，点卡片钻原始证据"
      : "先连接并发送文本、音频或协议消息";
    dom.overviewHints.innerHTML = `
      <strong>下一步</strong>
      <span>${escapeHtml(next)}</span>
      <span>${escapeHtml(state.roundLogFile || "server.log")}</span>
      <span>${escapeHtml(state.lastReport ? `场景 ${state.lastReport.ok ? "通过" : "失败"}` : "场景未执行")}</span>
    `;
  }
}

function renderOverviewHealth(summary = store.summary(), current = currentRound()) {
  if (!dom.overviewHealth) return;
  const connectionState = dom.connectionPill?.dataset.state || "idle";
  const logState = isCapabilityOk("logs") ? "ok" : state.capabilities.logs.status;
  const roundState = current ? "ok" : state.rounds.length ? "warn" : state.capabilities.rounds.status;
  const cards = [
    { label: "REST", state: state.healthStatus.rest, value: state.healthStatus.message },
    { label: "WS", state: connectionState === "connected" ? "ok" : connectionState === "error" ? "error" : "unknown", value: displayConnectionState(connectionState) },
    { label: "日志", state: logState, value: state.roundLogFile || state.capabilities.logs.message || "等待扫描 server.log" },
    { label: "轮次", state: roundState, value: current ? roundTitle(current) : state.rounds.length ? `${state.rounds.length} 轮` : state.capabilities.rounds.message }
  ];
  dom.overviewHealth.innerHTML = cards.map((card) => `
    <div class="health-card" data-state="${escapeHtml(card.state)}">
      <span>${escapeHtml(card.label)}</span>
      <strong title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</strong>
    </div>
  `).join("");
}

function renderEvidenceCards(summary = store.summary()) {
  const identity = readIdentityFromInputs();
  const connectionState = dom.connectionPill?.dataset.state || "idle";
  const playback = downlinkAudioPlayer?.stats();
  const cards = [
    { label: "身份", value: `角色 ${state.selectedRole} · ${shortText(identity.deviceId)} · ${shortText(identity.userId)}` },
    { label: "连接", value: `${displayConnectionState(connectionState)} · ${wsClient.sessionId ? shortText(wsClient.sessionId) : "未握手"}` },
    { label: "日志", value: `${shortText(identity.traceId)} · ${dom.logKeywordInput.value.trim() || "全量筛选"}` },
    { label: "音频", value: `${dom.audioFormatInput.value}/${dom.sampleRateInput.value}/${dom.frameDurationInput.value}ms · 出 ${summary.outboundBinary} / 入 ${summary.inboundBinary} · 播 ${playback?.playedFrames || 0}/丢 ${playback?.droppedFrames || 0}` }
  ];
  dom.evidenceCards.innerHTML = cards.map((card) => `
    <div class="evidence-card">
      <span>${escapeHtml(card.label)}</span>
      <strong title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</strong>
    </div>
  `).join("");
}

function renderInspectorContext() {
  if (!dom.contextEnvironment) return;
  const identity = readIdentityFromInputsSafe();
  const selectedEndpoint = dom.endpointPresetSelect?.selectedOptions?.[0]?.textContent || "自定义";
  const scenario = scenarios[dom.scenarioSelect?.value] || scenarios["role-text-smoke"];
  const latest = state.lastReport
    ? `${({ pass: "通过", degraded: "降级", blocked: "阻塞", fail: "失败" })[scenarioDatasetStatus(state.lastReport)] || "未知"} · ${displayScenarioName(state.lastReport.name)}`
    : scenario ? `待执行 · ${scenario.label || scenario.id}` : "待执行";
  dom.contextEnvironment.textContent = `${selectedEndpoint} · ${capabilitySummaryText()}`;
  dom.contextIdentity.textContent = `角色 ${state.selectedRole} · ${shortText(identity.deviceId || "device")} · ${shortText(identity.userId || "user")}`;
  dom.contextSession.textContent = wsClient.sessionId ? `${shortText(wsClient.sessionId)} · ${shortText(identity.traceId || "trace")}` : `${latest}`;
  const summary = store.summary();
  const playback = downlinkAudioPlayer?.stats();
  dom.contextAudio.textContent = `${dom.audioFormatInput.value}/${dom.sampleRateInput.value}/${dom.frameDurationInput.value}ms · 出 ${summary.outboundBinary}/入 ${summary.inboundBinary} · 播 ${playback?.playedFrames || 0}/丢 ${playback?.droppedFrames || 0}`;
  renderOverview();
}

function renderChainTimeline() {
  if (!dom.chainTimeline) return;
  const items = buildChainItems();
  state.chainItems = items;
  renderChainSummary(items);
  if (!items.length) {
    dom.chainTimeline.innerHTML = `<div class="chain-item"><span>会话链路</span><p class="chain-item-summary">等待连接、输入消息或日志洞察。</p></div>`;
    return;
  }
  dom.chainTimeline.innerHTML = items.slice(0, 80).map((item, index) => `
    <button type="button" class="chain-item" data-chain-index="${index}" data-testid="chain-item">
      <div class="chain-item-head">
        <span class="phase-pill" data-severity="${escapeHtml(item.severity || "info")}">${escapeHtml(item.phase)}</span>
        <strong class="chain-item-title">${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(formatInsightTime(item.time))}</span>
      </div>
      <p class="chain-item-summary">${escapeHtml(item.summary)}</p>
      <div class="chain-chip-row">${item.chips.map((chip) => `<span class="chain-chip">${escapeHtml(chip)}</span>`).join("")}</div>
    </button>
  `).join("");
}

function renderChainSummary(items) {
  if (!dom.chainSummary) return;
  const server = items.filter((item) => item.source === "server" || item.source === "log").length;
  const errors = items.filter((item) => item.severity === "error" || item.phase === "错误").length;
  const phases = new Set(items.map((item) => item.phase).filter(Boolean));
  dom.chainSummary.innerHTML = `
    <div><span>阶段</span><strong>${phases.size}</strong></div>
    <div><span>服务端/日志</span><strong>${server}</strong></div>
    <div><span>异常</span><strong>${errors}</strong></div>
  `;
}

function buildChainItems() {
  const eventItems = store.events.map((event) => ({
    source: event.direction,
    time: event.at,
    phase: classifyEventPhase(event),
    title: `${displayDirection(event.direction)} · ${displayEventType(event.type)}`,
    summary: displayEventBody(event) || event.label || event.type,
    severity: event.error ? "error" : "info",
    chips: [
      event.payload?.session_id ? `session ${shortText(event.payload.session_id)}` : "",
      event.payload?.trace_id ? `trace ${shortText(event.payload.trace_id)}` : "",
      event.kind === "binary" ? `${event.bytes || 0} bytes` : ""
    ].filter(Boolean),
    detail: event
  }));
  const logItems = state.logInsights.map((item) => ({
    source: "log",
    time: item.time,
    phase: item.phase || "日志",
    title: item.title || item.msg || "日志事件",
    summary: item.summary || item.raw_preview || "",
    severity: item.severity || item.level || "info",
    chips: logInsightChips(item),
    detail: item
  }));
  return [...eventItems, ...logItems].sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
}

async function handleLogInsightClick(event) {
  const card = event.target.closest("[data-log-index]");
  if (!card) return;
  const insight = state.logInsights[Number(card.dataset.logIndex)];
  if (!insight) return;
  await openLogInsightDetail(insight);
}

async function handleChainTimelineClick(event) {
  const card = event.target.closest("[data-chain-index]");
  if (!card) return;
  const item = state.chainItems[Number(card.dataset.chainIndex)];
  if (!item) return;
  if (item.source === "log" && item.detail?.line_no) {
    await openLogInsightDetail(item.detail);
    return;
  }
  openInspectorDetail({
    eyebrow: item.phase,
    title: item.title,
    meta: item.chips,
    body: item.detail
  });
}

async function openLogInsightDetail(insight) {
  let detail = insight;
  if (insight.line_no) {
    try {
      detail = await api.logDetail(insight.line_no);
    } catch (error) {
      detail = { ...insight, detail_error: error.message };
    }
  }
  openInspectorDetail({
    eyebrow: `${insight.phase || "日志"} · line ${insight.line_no || "-"}`,
    title: insight.title || "日志详情",
    meta: logInsightChips(insight),
    body: detail
  });
}

function openInspectorDetail({ eyebrow, title, meta = [], body }) {
  dom.inspectorDetailEyebrow.textContent = eyebrow || "Detail";
  dom.inspectorDetailTitle.textContent = title || "原始详情";
  dom.inspectorDetailMeta.innerHTML = meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  dom.inspectorDetailBody.textContent = typeof body === "string" ? body : JSON.stringify(sanitizeDetailBody(body), null, 2);
  if (typeof dom.inspectorDetailDialog.showModal === "function") {
    dom.inspectorDetailDialog.showModal();
  } else {
    dom.inspectorDetailDialog.setAttribute("open", "");
  }
}

function sanitizeDetailBody(value) {
  if (!value || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer || value instanceof Blob) {
    return "[binary payload omitted]";
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDetailBody);
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "binaryPayload") continue;
    output[key] = item instanceof ArrayBuffer || item instanceof Blob ? "[binary payload omitted]" : sanitizeDetailBody(item);
  }
  return output;
}

function closeInspectorDetail() {
  if (dom.inspectorDetailDialog.open && typeof dom.inspectorDetailDialog.close === "function") {
    dom.inspectorDetailDialog.close();
  } else {
    dom.inspectorDetailDialog.removeAttribute("open");
  }
}

function renderEventStream() {
  dom.eventStream.innerHTML = store.events.slice(0, 90).map((event) => {
    const time = new Date(event.at).toLocaleTimeString();
    const body = escapeHtml(displayEventBody(event));
    return `
      <div class="event-item">
        <div class="event-kind">${escapeHtml(displayEventType(event.type))}</div>
        <div class="event-body"><code>${time}</code> ${escapeHtml(displayDirection(event.direction))} · ${body}</div>
      </div>
    `;
  }).join("");
}

const TTS_CONVERSATION_FINAL_STATES = new Set(["sentence_end", "stop", "end", "completed", "complete"]);
const TTS_CONVERSATION_INTERRUPT_REASONS = new Set(["interrupt", "abort"]);
const TTS_TYPEWRITER_MIN_MS = 700;
const TTS_TYPEWRITER_MAX_MS = 12000;

function appendConversation(event) {
  if (!event) return;
  if (event.direction === "client" && event.payload?.type === "interrupt") {
    finishActiveTtsConversations("interrupted");
  }
  if (handleTtsConversationEvent(event)) return;
  const message = conversationMessage(event);
  if (!message) return;
  const key = message.dedupeKey || `${message.kind}:${message.text}`;
  if (message.suppressDuplicate && hasRecentConversationKey(key)) return;
  rememberConversationKey(key, message.dedupeTtlMs || 4000);
  appendConversationElement(message);
}

function appendConversationElement(message) {
  const el = document.createElement("div");
  el.className = `message ${message.kind}`;
  if (message.source) el.dataset.source = message.source;
  const labelEl = document.createElement("small");
  labelEl.textContent = message.label;
  const textEl = document.createElement("p");
  textEl.textContent = message.text;
  el.append(labelEl, textEl);
  dom.conversationList.appendChild(el);
  scrollConversationToBottom();
  return { el, labelEl, textEl };
}

function scrollConversationToBottom() {
  dom.conversationList.scrollTop = dom.conversationList.scrollHeight;
}

function pruneRecentConversationKeys(now = Date.now()) {
  state.recentConversationKeys = state.recentConversationKeys.filter((item) => now - item.at < (item.ttlMs || 4000));
  if (state.recentConversationKeys.length > 80) {
    state.recentConversationKeys = state.recentConversationKeys.slice(-80);
  }
}

function hasRecentConversationKey(key) {
  pruneRecentConversationKeys();
  return state.recentConversationKeys.some((item) => item.key === key);
}

function rememberConversationKey(key, ttlMs = 4000) {
  pruneRecentConversationKeys();
  state.recentConversationKeys.push({ key, at: Date.now(), ttlMs });
}

function handleTtsConversationEvent(event) {
  if (event.direction !== "server" || event.payload?.type !== "tts") return false;
  const payload = event.payload;
  const stateName = payload.state || "";
  const text = finalReadableText(payload);
  if (stateName === "sentence_start") {
    if (String(text || "").trim()) {
      upsertTtsConversationMessage(payload, text);
    }
    return true;
  }
  if (TTS_CONVERSATION_FINAL_STATES.has(stateName)) {
    finalizeTtsConversationMessage(payload, text, {
      interrupted: TTS_CONVERSATION_INTERRUPT_REASONS.has(payload.reason || "")
    });
    return true;
  }
  return true;
}

function upsertTtsConversationMessage(payload, text) {
  const displayText = String(text || "").trim();
  if (!displayText) return;
  const slot = ttsConversationSlot(payload, displayText);
  let key = slot ? state.activeTtsConversationSlots.get(slot) : "";
  if (!key) {
    key = `server-tts-stream:${++state.ttsConversationSeq}`;
    if (slot) state.activeTtsConversationSlots.set(slot, key);
  }
  let record = state.activeTtsConversationRecords.get(key);
  if (!record) {
    record = createTtsConversationRecord(key, slot);
    state.activeTtsConversationRecords.set(key, record);
  }
  record.slot = slot || record.slot;
  record.fullText = displayText;
  record.dedupeKey = ttsConversationDedupeKey(displayText);
  record.labelEl.textContent = "服务端 语音回复";
  record.el.classList.add("streaming");
  record.el.dataset.state = "streaming";
  startTtsTypewriter(record, displayText);
}

function createTtsConversationRecord(key, slot) {
  const view = appendConversationElement({
    kind: "server",
    label: "服务端 语音回复",
    text: "",
    source: "tts"
  });
  view.el.classList.add("streaming");
  view.el.dataset.state = "streaming";
  view.el.dataset.ttsKey = key;
  return {
    key,
    slot,
    fullText: "",
    visibleText: "",
    frameId: 0,
    dedupeKey: "",
    ...view
  };
}

function finalizeTtsConversationMessage(payload, text, options = {}) {
  const displayText = String(text || "").trim();
  const key = resolveActiveTtsConversationKey(payload, displayText);
  if (key) {
    const record = state.activeTtsConversationRecords.get(key);
    const finalText = displayText || record?.fullText || "";
    if (record) {
      finishTtsConversationRecord(record, options.interrupted ? "interrupted" : "complete", finalText);
    }
    return;
  }
  if (!displayText && payload.state === "stop") {
    finishActiveTtsConversations(options.interrupted ? "interrupted" : "complete");
    return;
  }
  if (!displayText) return;
  const dedupeKey = ttsConversationDedupeKey(displayText);
  if (hasRecentConversationKey(dedupeKey)) return;
  const view = appendConversationElement({
    kind: "server",
    label: options.interrupted ? "服务端 语音回复 · 已打断" : "服务端 语音回复",
    text: displayText,
    source: "tts"
  });
  view.el.dataset.state = options.interrupted ? "interrupted" : "complete";
  rememberConversationKey(dedupeKey, 4000);
}

function resolveActiveTtsConversationKey(payload, text) {
  const slot = ttsConversationSlot(payload, text);
  if (slot && state.activeTtsConversationSlots.has(slot)) {
    return state.activeTtsConversationSlots.get(slot);
  }
  const normalized = normalizeConversationText(text);
  if (normalized) {
    for (const record of state.activeTtsConversationRecords.values()) {
      if (normalizeConversationText(record.fullText) === normalized) return record.key;
    }
  }
  if (state.activeTtsConversationRecords.size === 1) {
    return state.activeTtsConversationRecords.keys().next().value;
  }
  return "";
}

function finishActiveTtsConversations(status) {
  for (const record of Array.from(state.activeTtsConversationRecords.values())) {
    finishTtsConversationRecord(record, status, record.fullText);
  }
}

function finishTtsConversationRecord(record, status, text) {
  cancelTtsTypewriter(record);
  const finalText = String(text || record.fullText || "").trim();
  if (finalText) {
    setTtsConversationText(record, finalText);
    record.dedupeKey = record.dedupeKey || ttsConversationDedupeKey(finalText);
  }
  record.el.classList.remove("streaming");
  record.el.dataset.state = status;
  record.labelEl.textContent = status === "interrupted" ? "服务端 语音回复 · 已打断" : "服务端 语音回复";
  if (record.dedupeKey) {
    rememberConversationKey(record.dedupeKey, 4000);
  }
  releaseTtsConversationRecord(record);
}

function releaseTtsConversationRecord(record) {
  for (const [slot, key] of Array.from(state.activeTtsConversationSlots.entries())) {
    if (key === record.key) state.activeTtsConversationSlots.delete(slot);
  }
  state.activeTtsConversationRecords.delete(record.key);
}

function startTtsTypewriter(record, text) {
  cancelTtsTypewriter(record);
  const fullText = String(text || "");
  const graphemes = splitGraphemes(fullText);
  const startCount = Math.min(splitGraphemes(record.visibleText || "").length, graphemes.length);
  if (prefersReducedMotion() || startCount >= graphemes.length) {
    setTtsConversationText(record, fullText);
    return;
  }
  const initialCount = Math.min(graphemes.length, Math.max(startCount, 1));
  setTtsConversationText(record, graphemes.slice(0, initialCount).join(""));
  if (initialCount >= graphemes.length) return;
  const durationMs = estimateTtsTypewriterDuration(fullText);
  const startedAt = performance.now();
  const remaining = graphemes.length - initialCount;
  const tick = (now) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    const nextCount = Math.min(graphemes.length, initialCount + Math.max(1, Math.round(remaining * progress)));
    setTtsConversationText(record, graphemes.slice(0, nextCount).join(""));
    if (nextCount < graphemes.length && state.activeTtsConversationRecords.has(record.key)) {
      record.frameId = requestAnimationFrame(tick);
    } else {
      record.frameId = 0;
    }
  };
  record.frameId = requestAnimationFrame(tick);
}

function cancelTtsTypewriter(record) {
  if (!record?.frameId) return;
  cancelAnimationFrame(record.frameId);
  record.frameId = 0;
}

function setTtsConversationText(record, text) {
  record.visibleText = String(text || "");
  record.textEl.textContent = record.visibleText;
  scrollConversationToBottom();
}

function estimateTtsTypewriterDuration(text) {
  const graphemes = splitGraphemes(text).filter((item) => item.trim());
  const duration = graphemes.reduce((total, item) => {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(item)) return total + 105;
    if (/[\u0e00-\u0e7f]/u.test(item)) return total + 95;
    return total + 55;
  }, 420);
  return Math.max(TTS_TYPEWRITER_MIN_MS, Math.min(TTS_TYPEWRITER_MAX_MS, duration));
}

function splitGraphemes(text) {
  const value = String(text || "");
  if (!value) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment);
  }
  return Array.from(value);
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function ttsConversationSlot(payload = {}, text = "") {
  const session = payload.session_id || wsClient.sessionId || "";
  const trace = payload.trace_id || "";
  const ttsType = payload.tts_type || "";
  const index = payload.index ?? payload.text_index ?? payload.textIndex;
  if (index !== undefined && index !== null && index !== "") {
    return `slot:${session}:${trace}:${ttsType}:${index}`;
  }
  const normalized = normalizeConversationText(text);
  return normalized ? `text:${session}:${trace}:${ttsType}:${normalized}` : "";
}

function ttsConversationDedupeKey(text) {
  return `server-tts:${normalizeConversationText(text) || String(text || "").trim()}`;
}

function conversationMessage(event) {
  if (event.direction === "system" && event.error) {
    return {
      kind: "system",
      label: "系统提示",
      text: event.error,
      suppressDuplicate: true,
      dedupeKey: `system-error:${event.error}`,
      dedupeTtlMs: 4000
    };
  }
  if (event.direction === "client" && event.type === "audio_input") {
    const text = finalReadableText(event.payload);
    return text ? {
      kind: "client",
      label: event.payload?.label || event.label || "客户端 音频输入",
      text,
      source: event.payload?.source || "audio"
    } : null;
  }
  if (event.direction === "client" && event.payload?.type === "listen" && event.payload.text) {
    return { kind: "client", label: "客户端 LISTEN", text: event.payload.text };
  }
  if (event.direction === "server" && event.payload && typeof event.payload === "object") {
    if (event.payload.type === "stt") {
      const text = finalReadableText(event.payload);
      if (!text || consumeExpectedInputText(text)) return null;
      return {
        kind: "client",
        label: "客户端 语音识别",
        text,
        source: "asr",
        suppressDuplicate: true,
        dedupeKey: `client-asr:${normalizeConversationText(text)}`,
        dedupeTtlMs: 4000
      };
    }
  }
  return null;
}

function finalReadableText(payload) {
  return payload.text || payload.content || payload.sentence || payload.message || "";
}

function normalizeConversationText(text) {
  return String(text || "").replace(/[\s，。！？、；：,.!?;:"'“”‘’（）()\[\]【】…]/g, "").trim();
}

function updateConnectionState(stateName) {
  const labels = {
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    error: "异常"
  };
  dom.connectionPill.dataset.state = stateName;
  dom.connectionLabel.textContent = labels[stateName] || stateName;
  updateQuickConnectionButton(stateName);
  dom.clientHandshakeLabel.textContent = displayConnectionState(stateName);
  dom.clientSessionLabel.textContent = wsClient.sessionId ? shortText(wsClient.sessionId) : "未握手";
  if (stateName === "idle") {
    dom.sessionIdLabel.textContent = "未握手";
    dom.clientSessionLabel.textContent = "未握手";
    state.activeAudioProfile = null;
    state.activePlaybackProfile = null;
    downlinkAudioPlayer?.clear("disconnect", { keepUnlocked: true, keepStats: true });
  }
  updateClientPanelState({ valid: !dom.helloPreview.closest(".preview-card")?.classList.contains("invalid"), stale: false, text: dom.helloValidity.textContent });
  renderInspectorContext();
}

async function handleQuickConnectionAction() {
  const stateName = dom.connectionPill?.dataset.state || "idle";
  if (stateName === "connecting") return;
  if (stateName === "connected" || wsClient.isConnected) {
    wsClient.disconnect();
    return;
  }
  probeEnvironmentCapabilities({ silent: true, force: true });
  await connectAndHello();
}

function updateQuickConnectionButton(stateName = "idle") {
  if (!dom.quickConnectBtn) return;
  const labels = {
    idle: "连接",
    connecting: "连接中",
    connected: "断开",
    error: "重试"
  };
  dom.quickConnectBtn.dataset.state = stateName;
  dom.quickConnectBtn.textContent = labels[stateName] || "连接";
  dom.quickConnectBtn.disabled = stateName === "connecting";
}

function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const ws = params.get("ws");
  const rest = params.get("rest");
  if (ws) {
    dom.wsUrlInput.value = normalizeWsInput(ws);
    state.urlEndpointOverride = true;
  }
  if (rest) {
    dom.restBaseInput.value = normalizeRestInput(rest);
    state.urlEndpointOverride = true;
  }
  const role = params.get("role");
  if (role && ROLE_CODES.includes(role)) {
    state.selectedRole = role;
    state.identity = createIdentity(role);
  }
  state.urlAutomation = {
    autoConnect: params.get("autoConnect") === "1",
    autorun: params.get("autorun") === "1",
    scenario: params.get("scenario") || ""
  };
}

async function maybeRunUrlAutomation() {
  const automation = state.urlAutomation;
  if (!automation) return;
  if (automation.scenario && scenarios[automation.scenario]) {
    dom.scenarioSelect.value = automation.scenario;
  }
  if (automation.autoConnect) {
    await connectAndHello();
  }
  if (automation.autorun) {
    await runSmokeScenario();
  }
}

function getDraftAudioProfile() {
  return getProfileFromInputs({
    format: dom.audioFormatInput.value,
    sampleRate: dom.sampleRateInput.value,
    frameDuration: dom.frameDurationInput.value
  });
}

function ensureActiveAudioProfile() {
  const draft = getDraftAudioProfile();
  if (!state.activeAudioProfile) {
    throw new Error("请先连接并完成 hello，再开始音频推流");
  }
  if (!profilesEqual(draft, state.activeAudioProfile)) {
    throw new Error("音频配置已变更，请断开重连，让 hello 与推流配置保持一致");
  }
  return state.activeAudioProfile;
}

function getDraftPlaybackProfile() {
  return getProfileFromInputs({
    format: dom.playbackFormatInput.value,
    sampleRate: dom.playbackSampleRateInput.value,
    frameDuration: dom.playbackFrameDurationInput.value
  });
}

function ensureActivePlaybackProfile() {
  return state.activePlaybackProfile || getDraftPlaybackProfile();
}

function applyPlaybackProfileFromHello(payload = {}) {
  const params = payload.audio_params || payload.playback_audio_params;
  if (!params) return;
  try {
    state.activePlaybackProfile = getProfileFromInputs({
      format: params.format || state.activePlaybackProfile?.format || dom.playbackFormatInput.value,
      sampleRate: params.sample_rate || state.activePlaybackProfile?.sampleRate || dom.playbackSampleRateInput.value,
      frameDuration: params.frame_duration || state.activePlaybackProfile?.frameDuration || dom.playbackFrameDurationInput.value
    });
  } catch {
    // Keep the locally negotiated playback profile if the server sends a partial or legacy hello.
  }
}

function profilesEqual(a, b) {
  return a.format === b.format && a.sampleRate === b.sampleRate && a.frameDuration === b.frameDuration;
}

function saveState() {
  const data = {
    wsUrl: normalizeWsInput(dom.wsUrlInput?.value),
    restBase: normalizeRestInput(dom.restBaseInput?.value),
    clientTab: state.clientTab,
    selectedRole: state.selectedRole,
    identity: readIdentityFromInputsSafe(),
    audio: {
      format: dom.audioFormatInput?.value,
      sampleRate: dom.sampleRateInput?.value,
      frameDuration: dom.frameDurationInput?.value,
      playbackFormat: dom.playbackFormatInput?.value,
      playbackSampleRate: dom.playbackSampleRateInput?.value,
      playbackFrameDuration: dom.playbackFrameDurationInput?.value,
      sleepMode: Boolean(dom.sleepModeInput?.checked)
    },
    helloOptions: {
      clientId: Boolean(dom.helloClientIdInput?.checked),
      token: Boolean(dom.helloTokenToggle?.checked),
      deviceName: Boolean(dom.helloDeviceNameToggle?.checked),
      deviceMac: Boolean(dom.helloDeviceMacToggle?.checked),
      playback: Boolean(dom.helloPlaybackToggle?.checked),
      features: Boolean(dom.helloFeaturesToggle?.checked),
      location: Boolean(dom.helloLocationToggle?.checked),
      clientInfo: Boolean(dom.helloClientInfoToggle?.checked),
      session: Boolean(dom.helloSessionToggle?.checked),
      sessionId: dom.helloSessionInput?.value,
      featuresJson: dom.helloFeaturesInput?.value,
      longitude: dom.helloLongitudeInput?.value,
      latitude: dom.helloLatitudeInput?.value,
      address: dom.helloAddressInput?.value,
      adCode: dom.helloAdCodeInput?.value,
      osType: dom.helloOsTypeInput?.value,
      appVersion: dom.helloAppVersionInput?.value,
      networkType: dom.helloNetworkTypeInput?.value,
      battery: dom.helloBatteryInput?.value
    },
    helloExtra: dom.helloExtraInput?.value,
    customEndpointConfigs: state.customEndpointConfigs,
    customProtocolTemplates: state.customProtocolTemplates
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function restoreState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved.wsUrl) {
      dom.wsUrlInput.value = normalizeWsInput(saved.wsUrl);
      state.restoredEndpointFromStorage = true;
    }
    if (saved.restBase) {
      dom.restBaseInput.value = normalizeRestInput(saved.restBase);
      state.restoredEndpointFromStorage = true;
    }
    state.customProtocolTemplates = normalizeSavedProtocolTemplates(saved.customProtocolTemplates);
    if (saved.clientTab) {
      state.clientTab = saved.clientTab;
      selectInitialClientTab(saved.clientTab);
    }
    state.customEndpointConfigs = normalizeSavedEndpointConfigs(saved.customEndpointConfigs);
    if (saved.selectedRole && ROLE_CODES.includes(saved.selectedRole)) {
      state.selectedRole = saved.selectedRole;
    }
    if (saved.identity?.deviceId) {
      state.identity = { ...state.identity, ...saved.identity };
      state.selectedRole = inferRoleFromDeviceId(saved.identity.deviceId);
    }
    if (saved.audio) {
      dom.audioFormatInput.value = saved.audio.format || "opus";
      dom.sampleRateInput.value = saved.audio.sampleRate || "24000";
      dom.frameDurationInput.value = saved.audio.frameDuration || "60";
      dom.playbackFormatInput.value = saved.audio.playbackFormat || saved.audio.format || "opus";
      dom.playbackSampleRateInput.value = saved.audio.playbackSampleRate || saved.audio.sampleRate || "24000";
      dom.playbackFrameDurationInput.value = saved.audio.playbackFrameDuration || saved.audio.frameDuration || "60";
      dom.sleepModeInput.checked = Boolean(saved.audio.sleepMode);
    }
    if (saved.helloOptions) {
      dom.helloClientIdInput.checked = saved.helloOptions.clientId !== false;
      dom.helloTokenToggle.checked = saved.helloOptions.token !== false;
      dom.helloDeviceNameToggle.checked = saved.helloOptions.deviceName !== false;
      dom.helloDeviceMacToggle.checked = saved.helloOptions.deviceMac !== false;
      dom.helloPlaybackToggle.checked = saved.helloOptions.playback !== false;
      dom.helloFeaturesToggle.checked = saved.helloOptions.features !== false;
      dom.helloLocationToggle.checked = Boolean(saved.helloOptions.location);
      dom.helloClientInfoToggle.checked = Boolean(saved.helloOptions.clientInfo);
      dom.helloSessionToggle.checked = Boolean(saved.helloOptions.session);
      dom.helloSessionInput.value = saved.helloOptions.sessionId || "";
      dom.helloFeaturesInput.value = saved.helloOptions.featuresJson || '{"mcp":true,"ws_lab":true}';
      dom.helloLongitudeInput.value = saved.helloOptions.longitude || "120.123456";
      dom.helloLatitudeInput.value = saved.helloOptions.latitude || "30.123456";
      dom.helloAddressInput.value = saved.helloOptions.address || "杭州市西湖区";
      dom.helloAdCodeInput.value = saved.helloOptions.adCode || "330106";
      dom.helloOsTypeInput.value = saved.helloOptions.osType || "Web";
      dom.helloAppVersionInput.value = saved.helloOptions.appVersion || "ws-lab";
      dom.helloNetworkTypeInput.value = saved.helloOptions.networkType || "wifi";
      dom.helloBatteryInput.value = saved.helloOptions.battery || "76";
    }
    if (saved.helloExtra) dom.helloExtraInput.value = saved.helloExtra;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function normalizeSavedProtocolTemplates(items) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const payload = isPlainObject(item.payload) ? item.payload : null;
    if (!payload?.type) continue;
    const id = typeof item.id === "string" && item.id.startsWith(CUSTOM_TEMPLATE_PREFIX)
      ? item.id
      : `${CUSTOM_TEMPLATE_PREFIX}${Date.now().toString(36)}-${normalized.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      label: String(item.label || item.name || payload.type).slice(0, 60),
      category: String(item.category || "自定义"),
      requires_session: item.requires_session !== false,
      payload,
      params: Array.isArray(item.params) ? item.params : inferTemplateParams(payload),
      expect: Array.isArray(item.expect) ? item.expect : [],
      custom: true
    });
  }
  return normalized.slice(0, 50);
}

function registerCustomProtocolTemplates() {
  for (const item of state.customProtocolTemplates) {
    templates[item.id] = item;
  }
}

function normalizeSavedEndpointConfigs(configs) {
  if (!Array.isArray(configs)) return [];
  const seen = new Set();
  const normalized = [];
  for (const config of configs) {
    const ws = normalizeEndpointValue(config?.ws);
    const rest = normalizeEndpointValue(config?.rest);
    if (validateEndpointDraft(ws, rest)) continue;
    const key = `${ws}\n${rest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      id: typeof config.id === "string" && config.id.startsWith("custom-") ? config.id : `custom-${normalized.length}-${Date.now().toString(36)}`,
      label: typeof config.label === "string" && config.label.trim() ? config.label.trim().slice(0, 60) : createCustomEndpointLabel(ws),
      ws,
      rest,
      custom: true
    });
  }
  return normalized.slice(0, 20);
}

function readIdentityFromInputsSafe() {
  if (!dom.deviceIdInput) return state.identity;
  return readIdentityFromInputs();
}

function selectInitialClientTab(targetId) {
  if (!dom.clientTabs || !targetId) return;
  const tabs = Array.from(dom.clientTabs.querySelectorAll("[data-tab-target]"));
  if (!tabs.some((tab) => tab.dataset.tabTarget === targetId)) return;
  for (const tab of tabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.tabTarget === targetId));
  }
}

function deepMerge(base, extra) {
  const output = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function getHelloExtraConflicts(hello) {
  const text = dom.helloExtraInput.value.trim();
  if (!text) return [];
  const extra = JSON.parse(text);
  const protectedPaths = getProtectedHelloPaths(hello);
  return flattenObjectPaths(extra).filter((path) => protectedPaths.has(path) || protectedPaths.has(path.split(".")[0]));
}

function getProtectedHelloPaths(hello) {
  const paths = new Set([
    "type",
    "version",
    "transport",
    "device_id",
    "user_id",
    "trace_id",
    "client_ip",
    "audio_params",
    "audio_params.format",
    "audio_params.sample_rate",
    "audio_params.channels",
    "audio_params.frame_duration"
  ]);
  if (dom.helloClientIdInput.checked) paths.add("client_id");
  if (dom.helloTokenToggle.checked) paths.add("token");
  if (dom.helloDeviceNameToggle.checked) paths.add("device_name");
  if (dom.helloDeviceMacToggle.checked) paths.add("device_mac");
  if (dom.helloPlaybackToggle.checked) {
    paths.add("playback_audio_params");
    paths.add("playback_audio_params.format");
    paths.add("playback_audio_params.sample_rate");
    paths.add("playback_audio_params.channels");
    paths.add("playback_audio_params.frame_duration");
  }
  if (dom.helloFeaturesToggle.checked) {
    for (const path of flattenObjectPaths(parseJsonObject(dom.helloFeaturesInput.value, "features"), "features")) paths.add(path);
  }
  if (dom.helloLocationToggle.checked) {
    for (const path of ["location", "location.longitude", "location.latitude", "location.address", "location.ad_code"]) paths.add(path);
  }
  if (dom.helloClientInfoToggle.checked) {
    for (const path of [
      "client_info",
      "client_info.os_type",
      "client_info.os_version",
      "client_info.app_version",
      "client_info.network_type",
      "client_info.network_provider",
      "client_info.timezone",
      "client_info.country_code",
      "client_info.battery_level",
      "client_info.is_charging"
    ]) paths.add(path);
  }
  if (dom.helloSessionToggle.checked && dom.helloSessionInput.value.trim()) paths.add("session_id");
  if (dom.sleepModeInput.checked) paths.add("sleep_mode");
  return paths;
}

function flattenObjectPaths(value, prefix = "") {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  const paths = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) {
      paths.push(...flattenObjectPaths(entry, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function flattenPayload(value, prefix = "") {
  if (!isPlainObject(value)) return [];
  const fields = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) {
      fields.push(...flattenPayload(entry, path));
    } else if (!Array.isArray(entry)) {
      fields.push({ path, value: entry });
    }
  }
  return fields;
}

function getPathValue(target, path) {
  return path.split(".").reduce((current, key) => current?.[key], target);
}

function setPathValue(target, path, value) {
  const parts = path.split(".");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

function normalizeTemplate(id, source = {}) {
  const payload = typeof source.payload === "function" ? source.payload : structuredClone(source.payload || {});
  return {
    id: source.id || id,
    label: source.label || source.name || id,
    category: source.category || displayArea(source.area || "协议"),
    description: source.description || "",
    requires_session: source.requires_session ?? source.requiresSession ?? true,
    payload,
    params: Array.isArray(source.params) ? source.params : inferTemplateParams(payload),
    expect: Array.isArray(source.expect) ? source.expect : []
  };
}

function createTemplatePayload(template) {
  return typeof template.payload === "function" ? template.payload() : structuredClone(template.payload || {});
}

function getTemplateFields(template, payload) {
  if (Array.isArray(template.params) && template.params.length) {
    return template.params.map((param) => ({
      ...param,
      value: getPathValue(payload, param.path) ?? param.default ?? ""
    }));
  }
  return flattenPayload(payload).filter((field) => ["string", "number", "boolean"].includes(typeof field.value));
}

function inferTemplateParams(payload) {
  if (typeof payload === "function") return [];
  return flattenPayload(payload).filter((field) => ["string", "number", "boolean"].includes(typeof field.value)).map((field) => ({
    path: field.path,
    label: displayParamPath(field.path),
    type: typeof field.value
  }));
}

function coerceParamValue(value, current, explicitType = "") {
  const type = explicitType || typeof current;
  if (type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : current;
  }
  if (type === "boolean") {
    return value === "true" || value === "1" || value === "是";
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function scenarioProductGroup(scenario = {}) {
  const area = String(scenario.area || scenario.category || "").toLowerCase();
  const id = String(scenario.id || "").toLowerCase();
  if (scenario.builtin || area.includes("core") || id.includes("hello") || id.includes("role")) return "连接与身份";
  if (id.includes("text") || id.includes("listen") || area.includes("interaction")) return "文本对话";
  if (id.includes("audio") || id.includes("wav") || id.includes("mic")) return "音频链路";
  if (id.includes("interrupt") || id.includes("sleep") || id.includes("heartbeat") || id.includes("reconnect")) return "打断与状态";
  if (id.includes("greet") || id.includes("vision") || id.includes("environment") || id.includes("tool") || id.includes("mcp")) return "主动能力";
  if (id.includes("error") || id.includes("invalid") || area.includes("error")) return "异常保护";
  return displayArea(scenario.area || "场景");
}

function scenarioStability(scenario = {}) {
  const explicit = scenario.stability || scenario.mode || "";
  if (explicit) return displayStability(explicit);
  const id = String(scenario.id || "").toLowerCase();
  if (scenario.builtin || id.includes("smoke") || id.includes("required") || id.includes("unknown-type")) return "strict";
  if (id.includes("mic") || id.includes("mcp") || id.includes("vision")) return "experimental";
  return "diagnostic";
}

function scenarioPurpose(scenario = {}) {
  if (scenario.description) return scenario.description;
  const group = scenarioProductGroup(scenario);
  const purpose = {
    "连接与身份": "验证 WS 连接、Hello 握手、角色设备映射和基础身份字段。",
    "文本对话": "验证客户端文本输入能触发服务端回复，并保留可验收证据。",
    "音频链路": "验证指定音频格式、采样率和帧长的上行链路。",
    "打断与状态": "验证状态切换、打断、保活或重连行为不会破坏会话。",
    "主动能力": "验证主动问候、环境视觉或工具类能力的服务端链路。",
    "异常保护": "验证异常协议不会导致会话不可控退出。"
  };
  return purpose[group] || "验证该模块注册的协议场景，并沉淀可复用验收证据。";
}

function scenarioExpectedEvidence(scenario = {}) {
  if (scenario.builtin) return "期待 Hello + 服务端回复 + 日志证据";
  const expects = new Set();
  for (const step of scenario.steps || []) {
    if (step.action === "wait_ws" && step.type) expects.add(`WS ${step.type}`);
    if (step.action === "expect_binary") expects.add("下行音频");
    if (step.action === "log_summary") expects.add("日志里程碑");
    if (step.action === "log_expect") expects.add("日志关键字");
  }
  return expects.size ? `期待 ${Array.from(expects).join(" / ")}` : "期待步骤全部通过";
}

function scenarioPrecondition(scenario = {}) {
  if (scenario.builtin || scenario.auto_connect !== false) return "前置: 自动连接";
  if ((scenario.steps || []).some((step) => step.action === "connect_hello" || step.action === "connect_ws")) return "前置: 场景内连接";
  return "前置: 需要当前会话";
}

function scenarioFailureHint(scenario = {}) {
  if (scenario.builtin) return "失败看步骤与日志证据";
  const actions = new Set((scenario.steps || []).map((step) => step.action));
  if (actions.has("log_expect")) return "失败先看日志关键字";
  if (actions.has("log_summary")) return "失败先看日志里程碑";
  if (actions.has("expect_binary")) return "失败先看音频帧";
  if (actions.has("wait_ws")) return "失败先看链路阶段";
  return "失败看原始详情";
}

function scenarioStepSummary(scenario = {}) {
  if (scenario.builtin) return "4 步";
  const count = Array.isArray(scenario.steps) ? scenario.steps.length : 0;
  return `${count || 1} 步`;
}

function displayStability(value) {
  return ({
    strict: "strict",
    diagnostic: "diagnostic",
    experimental: "experimental",
    mutating: "mutating"
  })[String(value).toLowerCase()] || value;
}

function moduleDomain(item = {}) {
  const text = `${item.area || ""} ${item.id || ""} ${item.name || ""}`.toLowerCase();
  if (text.includes("hello") || text.includes("auth") || text.includes("ota")) return "连接与身份";
  if (text.includes("listen") || text.includes("greet") || text.includes("interaction")) return "监听与对话";
  if (text.includes("audio")) return "音频矩阵";
  if (text.includes("vision") || text.includes("environment")) return "视觉与环境";
  if (text.includes("heartbeat") || text.includes("status")) return "状态与保活";
  if (text.includes("tool") || text.includes("mcp")) return "工具与 MCP";
  if (text.includes("error") || text.includes("reconnect") || text.includes("invalid")) return "异常保护";
  return displayArea(item.area || "通用");
}

function moduleCoverageText(item = {}) {
  const parts = [
    `${item.actionCount || 0} 动作`,
    `${item.scenarioCount || 0} 场景`,
    displayArea(item.area || "通用")
  ];
  return parts.join(" · ");
}

function renderMissingCoverage(snapshot) {
  const existing = new Set([
    ...snapshot.modules.map((item) => moduleDomain(item)),
    ...snapshot.scenarios.map((item) => scenarioProductGroup(item))
  ]);
  const recommended = ["连接与身份", "监听与对话", "音频矩阵", "视觉与环境", "工具与 MCP", "设备控制", "状态与保活", "异常保护"];
  const missing = recommended.filter((item) => !existing.has(item));
  if (!missing.length) return "";
  return `
    <section class="module-group">
      <div class="module-group-title">
        <span>建议补齐</span>
        <span>${missing.length} 项</span>
      </div>
      ${missing.map((name) => `
        <div class="module-row diagnostic">
          <span class="module-main"><strong>${escapeHtml(name)}</strong><em>后续可新增模块或场景覆盖</em></span>
          <span class="status-pill warn">缺口</span>
        </div>
      `).join("")}
    </section>
  `;
}

function classifyEventPhase(event) {
  const type = event?.payload?.type || event?.type || "";
  if (event?.type === "module") return "模块";
  if (event?.type === "log") return "日志";
  if (event?.type === "socket") return "连接";
  if (type === "hello") return "Hello";
  if (String(type).includes("auth")) return "认证";
  if (String(type).includes("listen") || String(type).includes("sleep")) return "监听";
  if (event?.direction === "client" && (type === "listen" || event.kind === "text")) return "输入";
  if (type === "stt" || String(type).includes("asr")) return "ASR";
  if (String(type).includes("intent")) return "意图";
  if (String(type).includes("mcp") || String(type).includes("tool")) return "工具";
  if (String(type).includes("llm")) return "LLM";
  if (type === "tts") return "TTS";
  if (String(type).includes("latency")) return "延迟";
  if (event?.error || type === "goodbye" || String(type).includes("error")) return "错误";
  if (event?.kind === "binary" || type === "audio") return "下发";
  return "连接";
}

function logInsightChips(item = {}) {
  return [
    item.level ? `level ${item.level}` : "",
    item.source ? `source ${item.source}` : "",
    item.user_id ? `user ${shortText(item.user_id)}` : "",
    item.device_id ? `device ${shortText(item.device_id)}` : "",
    item.session_id ? `session ${shortText(item.session_id)}` : "",
    item.trace_id ? `trace ${shortText(item.trace_id)}` : "",
    item.line_no ? `line ${item.line_no}` : ""
  ].filter(Boolean).slice(0, 6);
}

function formatInsightTime(value) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(11, 19) || String(value);
  return date.toLocaleTimeString();
}

function roundTitle(round = {}) {
  const roundId = round.round || "未归属";
  const identity = round.user_id || round.device_id || round.trace_id || "unknown";
  return `round ${roundId} · ${shortText(identity)}`;
}

function roundPreview(round = {}) {
  return roundInputText(round) || `${round.cards?.length || 0} 个模块`;
}

function roundInputText(round = {}) {
  return round.input?.asr_text || round.input?.text || firstRoundFact(round, "识别文本") || firstRoundFact(round, "模型响应") || "未采集输入";
}

function firstRoundFact(round, label) {
  for (const card of round.cards || []) {
    const fact = (card.facts || []).find((item) => item.label === label);
    if (fact?.value) return fact.value;
  }
  return "";
}

function roundMetricPreview(round = {}) {
  const latency = round.latency || {};
  const parts = [];
  if (latency.e2e_ttfr_ms !== undefined) parts.push(`E2E ${latency.e2e_ttfr_ms}ms`);
  if (latency.llm_model_ms !== undefined) parts.push(`LLM ${latency.llm_model_ms}ms`);
  if (latency.tts_synth_to_send_ms !== undefined) parts.push(`TTS ${latency.tts_synth_to_send_ms}ms`);
  if (round.evidence?.missing_count) parts.push(`缺失 ${round.evidence.missing_count}`);
  if (round.evidence?.unknown_count) parts.push(`其他 ${round.evidence.unknown_count}`);
  return parts.join(" · ") || `${round.evidence?.raw_count || 0} 条证据`;
}

function roundSeverity(round = {}) {
  if (round.status === "failed") return "error";
  if (round.status === "partial" || round.evidence?.missing_count) return "warning";
  return "info";
}

function displayRoundStatus(status) {
  return ({
    completed: "完成",
    in_progress: "进行中",
    partial: "部分",
    failed: "失败",
    missing: "缺失",
    idle: "未触发",
    observed: "已观察",
    triggered: "触发",
    skipped: "跳过",
    disabled: "关闭",
    timeout: "超时",
    unknown: "未知"
  })[status] || status || "未知";
}

function formatRoundRange(round = {}) {
  const start = formatInsightTime(round.time_start);
  const end = formatInsightTime(round.time_end);
  if (start === end) return start;
  return `${start} - ${end}`;
}

function previewInline(value, limit = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function displayArea(area) {
  return ({
    Core: "核心链路",
    "Core WS": "核心 WS",
    Interaction: "交互",
    "Optional Tools": "可选工具",
    Transport: "传输",
    JavaScript: "脚本模块",
    Imported: "导入场景",
    General: "通用",
    Error: "异常",
    Scenario: "场景",
    Audio: "音频"
  })[area] || area;
}

function displayEventType(type) {
  return ({
    lab: "实验室",
    module: "模块",
    rest: "REST",
    socket: "连接",
    log: "日志",
    audio: "音频",
    report: "报告",
    round: "轮次",
    scenario: "场景",
    raw: "原始消息",
    malformed_json: "非 JSON",
    hello: "握手",
    listen: "监听",
    tts: "语音回复",
    stt: "语音识别",
    interrupt: "打断",
    interrupt_complete: "打断完成",
    audio_frame: "音频帧",
    service_status: "服务状态",
    auth_result: "认证结果",
    goodbye: "断开",
    image: "图片",
    ping: "心跳",
    json: "JSON"
  })[type] || type;
}

function displayEventBody(event) {
  if (!event) return "";
  if (event.error) return event.error;
  if (event.kind === "binary") return `${event.bytes} bytes`;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return eventText(event);
  }
  if (payload.type === "hello") {
    const session = payload.session_id ? `会话 ${shortText(payload.session_id)}` : "等待会话";
    const trace = payload.trace_id ? `追踪 ${shortText(payload.trace_id)}` : "";
    const audio = payload.audio_params ? `${payload.audio_params.format}/${payload.audio_params.sample_rate}/${payload.audio_params.frame_duration}ms` : "";
    return [session, trace, audio].filter(Boolean).join(" · ");
  }
  if (payload.type === "listen" && payload.text) {
    return payload.text;
  }
  if (payload.type === "tts" || payload.type === "stt") {
    return [payload.state, payload.text || payload.sentence || payload.message].filter(Boolean).join(" · ") || eventText(event);
  }
  if (payload.type === "interrupt") {
    const session = payload.session_id ? `会话 ${shortText(payload.session_id)}` : "等待会话";
    return ["请求打断当前播放", session].filter(Boolean).join(" · ");
  }
  if (payload.type === "interrupt_complete") {
    return [payload.reason || "服务端已确认打断", payload.session_id ? `会话 ${shortText(payload.session_id)}` : ""].filter(Boolean).join(" · ");
  }
  if (event.type === "socket") {
    return event.label || payload.url || eventText(event);
  }
  if (event.type === "log") {
    return [payload.msg, payload.device_id, payload.user_id].filter(Boolean).join(" · ");
  }
  return payload.message || event.label || eventText(event);
}

function displayDirection(direction) {
  return ({
    client: "客户端",
    server: "服务端",
    system: "系统"
  })[direction] || direction;
}

function displayStatus(status) {
  return ({
    pass: "通过",
    fail: "失败",
    running: "执行中",
    skipped: "跳过",
    degraded: "降级",
    blocked: "阻塞"
  })[status] || status;
}

function displayConnectionState(stateName) {
  return ({
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    error: "异常"
  })[stateName] || stateName;
}

function displayStepName(name) {
  return ({
    connect: "连接",
    hello: "握手",
    text: "文本消息",
    logs: "日志证据",
    send_json: "发送 JSON",
    send_text: "发送文本",
    wait_ws: "等待服务端消息",
    expect_no_ws: "反向断言",
    expect_binary: "等待音频帧",
    log_summary: "日志分析",
    connect_ws: "连接 WS",
    connect_hello: "连接并握手",
    disconnect: "断开连接",
    wait: "等待",
    set_audio_profile: "设置音频配置",
    stream_silence: "静音推流",
    send_hello: "发送 Hello",
    send_raw: "发送原始消息"
  })[name] || name;
}

function displayParamPath(path) {
  return ({
    type: "类型",
    action: "动作",
    session_type: "会话类型",
    state: "状态",
    mode: "模式",
    text: "文本",
    switch: "开关",
    session_id: "会话 ID",
    source: "来源",
    "image_data.url": "图片 URL",
    "response.device_id": "设备 ID",
    "response.challenge_id": "挑战 ID",
    "response.signature": "签名",
    "response.timestamp": "时间戳"
  })[path] || path;
}

function displayScenarioName(name) {
  return scenarios[name]?.label || name;
}

function displayAudioState(value) {
  if (!value) return "";
  if (value.startsWith("streaming ")) {
    return `推流中 · ${value.slice("streaming ".length)}`;
  }
  return ({
    idle: "空闲",
    decoding: "解码中",
    generating: "生成中",
    reserved: "准备中",
    mic: "麦克风中",
    error: "异常"
  })[value] || value;
}

function shortText(value, head = 8, tail = 4) {
  const text = String(value);
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markBootReady() {
  window.__WS_LAB_BOOTSTRAP__?.markReady?.();
}

function markBootError(error) {
  window.__WS_LAB_BOOTSTRAP__?.markError?.(error?.message || String(error || "unknown error"));
}
