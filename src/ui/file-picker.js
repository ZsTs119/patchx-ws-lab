const filePickerInstances = new WeakMap();

export function enhanceFilePickers(root = document) {
  for (const input of root.querySelectorAll('input[type="file"]')) {
    if (!filePickerInstances.has(input)) {
      filePickerInstances.set(input, new FilePicker(input));
    }
    filePickerInstances.get(input).refresh();
  }
}

class FilePicker {
  constructor(input) {
    this.input = input;
    this.wrapper = document.createElement("div");
    this.wrapper.className = "file-picker";
    this.wrapper.dataset.testid = `${input.dataset.testid || input.id || "file"}-picker`;

    this.pickButton = document.createElement("button");
    this.pickButton.type = "button";
    this.pickButton.className = "file-picker-button";
    this.pickButton.textContent = "选择 WAV";

    this.name = document.createElement("span");
    this.name.className = "file-picker-name";

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "file-picker-clear";
    this.clearButton.textContent = "清除";

    this.wrapper.append(this.pickButton, this.name, this.clearButton);
    this.input.classList.add("native-file-hidden");
    this.input.after(this.wrapper);

    this.pickButton.addEventListener("click", () => this.input.click());
    this.clearButton.addEventListener("click", () => this.clear());
    this.input.addEventListener("change", () => this.refresh());
  }

  refresh() {
    const file = this.input.files?.[0];
    this.name.textContent = file ? file.name : "未选择文件";
    this.clearButton.hidden = !file;
    this.pickButton.disabled = this.input.disabled;
  }

  clear() {
    this.input.value = "";
    this.input.dispatchEvent(new Event("change", { bubbles: true }));
    this.refresh();
  }
}
