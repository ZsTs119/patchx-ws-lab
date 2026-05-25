export function bindTabs(tablist) {
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll("[data-tab-target]"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (isDisabledTab(tab)) return;
      activateTab(tablist, tab.dataset.tabTarget);
    });
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const availableTabs = tabs.filter((item) => !isDisabledTab(item));
      const index = availableTabs.indexOf(tab);
      if (index < 0 || !availableTabs.length) return;
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % availableTabs.length;
      if (event.key === "ArrowLeft") next = (index - 1 + availableTabs.length) % availableTabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = availableTabs.length - 1;
      activateTab(tablist, availableTabs[next].dataset.tabTarget);
      availableTabs[next].focus({ preventScroll: true });
    });
  }
  const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true" && !isDisabledTab(tab))
    || tabs.find((tab) => !isDisabledTab(tab))
    || tabs[0];
  if (selected) {
    activateTab(tablist, selected.dataset.tabTarget);
  }
}

export function activateTab(tablist, targetId) {
  const root = tablist.closest(".panel") || document;
  for (const tab of tablist.querySelectorAll("[data-tab-target]")) {
    const active = tab.dataset.tabTarget === targetId;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of root.querySelectorAll("[data-tab-panel]")) {
    const active = panel.id === targetId;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
}

function isDisabledTab(tab) {
  return tab.disabled || tab.getAttribute("aria-disabled") === "true";
}
