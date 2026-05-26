const WS_LAB_ASSET_VERSION = "20260526-asr-scenes1";

export class ModuleHost {
  constructor({ store }) {
    this.store = store;
    this.modules = [];
    this.actions = [];
    this.scenarios = [];
    this.errors = [];
  }

  async load(registryUrl = "./modules/registry.json") {
    const response = await fetch(versionedAssetUrl(registryUrl), { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`模块注册表加载失败：HTTP ${response.status}`);
    }
    const registry = await response.json();
    const entries = Array.isArray(registry.modules) ? registry.modules : [];
    for (const entry of entries) {
      try {
        await this.loadEntry(entry);
      } catch (error) {
        this.errors.push({ id: entry.id || entry.path || "unknown", message: error.message });
        this.store.add({
          direction: "system",
          type: "module",
          label: "模块配置无效",
          payload: { id: entry.id || entry.path || "unknown", message: error.message }
        });
      }
    }
    return this.snapshot();
  }

  async loadEntry(entry) {
    if (!entry || !entry.path) {
      throw new Error("模块注册项无效");
    }
    if (entry.type === "js") {
      const imported = await import(versionedAssetUrl(entry.path));
      const value = typeof imported.default === "function"
        ? await imported.default(this.createHostApi(entry.id))
        : imported.default;
      this.registerManifest(value, entry);
      return;
    }

    const response = await fetch(versionedAssetUrl(entry.path), { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`模块 ${entry.path} 加载失败：HTTP ${response.status}`);
    }
    this.registerManifest(await response.json(), entry);
  }

  registerManifest(manifest, entry = {}) {
    validateManifest(manifest);
    const moduleId = manifest.id || entry.id;
    const normalized = {
      id: moduleId,
      name: manifest.name,
      area: manifest.area || "General",
      version: manifest.version || "0.0.0",
      description: manifest.description || ""
    };
    this.modules.push(normalized);

    for (const action of manifest.actions || []) {
      this.actions.push({ ...action, moduleId, area: normalized.area });
    }
    for (const scenario of manifest.scenarios || []) {
      this.scenarios.push({ ...scenario, moduleId, area: normalized.area });
    }
  }

  createHostApi(moduleId) {
    return {
      registerAction: (action) => {
        if (!action?.id || !action?.label || !action?.payload) {
          throw new Error(`JS 模块 ${moduleId} 注册了无效动作`);
        }
        this.actions.push({ ...action, moduleId, area: action.area || "JavaScript" });
      },
      registerScenario: (scenario) => {
        if (!scenario?.id || !scenario?.label || !Array.isArray(scenario.steps)) {
          throw new Error(`JS 模块 ${moduleId} 注册了无效场景`);
        }
        this.scenarios.push({ ...scenario, moduleId, area: scenario.area || "JavaScript" });
      },
      emit: (payload) => {
        this.store.add({ direction: "system", type: "module", payload: { module_id: moduleId, ...payload } });
      }
    };
  }

  snapshot() {
    return {
      modules: [...this.modules],
      actions: [...this.actions],
      scenarios: [...this.scenarios],
      errors: [...this.errors]
    };
  }
}

function versionedAssetUrl(path) {
  const url = new URL(path, window.location.href);
  url.searchParams.set("v", WS_LAB_ASSET_VERSION);
  return url.href;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("模块配置必须是对象");
  }
  if (!manifest.id || !manifest.name) {
    throw new Error("模块配置缺少 id 或 name");
  }
  if (manifest.actions && !Array.isArray(manifest.actions)) {
    throw new Error(`模块 ${manifest.id} 的 actions 必须是数组`);
  }
  if (manifest.scenarios && !Array.isArray(manifest.scenarios)) {
    throw new Error(`模块 ${manifest.id} 的 scenarios 必须是数组`);
  }
}
