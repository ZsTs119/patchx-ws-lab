const instances = new WeakMap();
let activeInstance = null;

export function enhanceSelectControls(root = document) {
  for (const select of root.querySelectorAll("select")) {
    if (!instances.has(select)) {
      instances.set(select, new SelectPopover(select));
    }
    instances.get(select).refresh();
  }
}

export function refreshSelectControl(select) {
  instances.get(select)?.refresh();
}

export function refreshSelectControls(root = document) {
  for (const select of root.querySelectorAll("select")) {
    instances.get(select)?.refresh();
  }
}

class SelectPopover {
  constructor(select) {
    this.select = select;
    this.wrapper = document.createElement("div");
    this.wrapper.className = "select-popover";
    this.wrapper.dataset.testid = `${select.dataset.testid || select.id || "select"}-popover`;

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "select-popover-button";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");

    this.list = document.createElement("div");
    this.list.className = "select-popover-list";
    this.list.setAttribute("role", "listbox");
    this.list.hidden = true;

    this.wrapper.append(this.button, this.list);
    this.select.classList.add("native-select-hidden");
    this.select.setAttribute("tabindex", "-1");
    this.select.after(this.wrapper);

    this.button.addEventListener("click", () => this.toggle());
    this.button.addEventListener("keydown", (event) => this.onButtonKeydown(event));
    this.select.addEventListener("change", () => this.refresh());
  }

  refresh() {
    const selected = this.select.selectedOptions[0] || this.select.options[0];
    this.button.textContent = selected?.textContent || "请选择";
    this.button.title = selected?.title || selected?.textContent || "";
    this.button.disabled = this.select.disabled;
    this.button.setAttribute("aria-label", this.select.getAttribute("aria-label") || selected?.textContent || "选择");
    this.list.innerHTML = "";

    for (const option of this.select.options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "select-popover-option";
      item.textContent = option.textContent;
      item.title = option.title || option.textContent;
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.disabled = option.disabled;
      item.addEventListener("click", () => this.choose(option.value));
      this.list.appendChild(item);
    }
  }

  toggle() {
    if (this.list.hidden) {
      this.open();
    } else {
      this.close();
    }
  }

  open() {
    if (activeInstance && activeInstance !== this) {
      activeInstance.close();
    }
    activeInstance = this;
    this.list.hidden = false;
    this.positionList();
    this.button.setAttribute("aria-expanded", "true");
    const selected = this.list.querySelector('[aria-selected="true"]') || this.list.querySelector(".select-popover-option");
    selected?.focus({ preventScroll: true });
  }

  close() {
    this.list.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    if (activeInstance === this) {
      activeInstance = null;
    }
  }

  positionList() {
    const gap = 6;
    const viewportPadding = 14;
    const rect = this.button.getBoundingClientRect();
    const availableAbove = Math.max(0, rect.top - viewportPadding - gap);
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap);
    const forcedPlacement = this.select.dataset.popoverPlacement;
    const preferTop = Boolean(this.wrapper.closest(".input-dock"));
    const desiredHeight = Math.min(this.list.scrollHeight || 220, 240);
    const placement = forcedPlacement === "bottom"
      ? "bottom"
      : preferTop || availableBelow < Math.min(desiredHeight, 160) ? "top" : "bottom";
    const available = placement === "top" ? availableAbove : availableBelow;
    const maxHeight = Math.max(112, Math.min(desiredHeight, available));

    this.wrapper.dataset.placement = placement;
    this.list.style.setProperty("--select-popover-max-height", `${maxHeight}px`);
  }

  choose(value) {
    if (this.select.value !== value) {
      this.select.value = value;
      this.select.dispatchEvent(new Event("input", { bubbles: true }));
      this.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.refresh();
    this.close();
    this.button.focus({ preventScroll: true });
  }

  onButtonKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.open();
    }
  }
}

document.addEventListener("click", (event) => {
  if (activeInstance && !activeInstance.wrapper.contains(event.target)) {
    activeInstance.close();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeInstance) {
    activeInstance.close();
    activeInstance.button.focus({ preventScroll: true });
  }
  if (!activeInstance || !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
    return;
  }
  const options = Array.from(activeInstance.list.querySelectorAll(".select-popover-option:not(:disabled)"));
  const index = options.indexOf(document.activeElement);
  if (event.key === "Enter" || event.key === " ") {
    if (document.activeElement?.classList.contains("select-popover-option")) {
      event.preventDefault();
      activeInstance.choose(document.activeElement.dataset.value);
    }
    return;
  }
  event.preventDefault();
  let nextIndex = index;
  if (event.key === "ArrowDown") nextIndex = Math.min(options.length - 1, index + 1);
  if (event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = options.length - 1;
  options[nextIndex]?.focus({ preventScroll: true });
});

window.addEventListener("resize", () => {
  activeInstance?.positionList();
});

document.addEventListener(
  "scroll",
  () => {
    activeInstance?.positionList();
  },
  true,
);
