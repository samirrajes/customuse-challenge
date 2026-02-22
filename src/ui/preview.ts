type DotState = "idle" | "good" | "bad";

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function setDot(dot: HTMLElement, state: DotState) {
  dot.classList.remove("good", "bad");
  if (state === "good") dot.classList.add("good");
  if (state === "bad") dot.classList.add("bad");
}

export function setPreview(
  which: "avatar" | "accessory",
  els: any,
  file: File,
  state: string,
  dot: DotState
) {
  if (which === "avatar") {
    els.avatarPreview.style.display = "grid";
    els.avatarNameEl.textContent = file.name;
    els.avatarSizeEl.textContent = formatBytes(file.size);
    els.avatarStateEl.textContent = state;
    setDot(els.avatarDotEl, dot);
  } else {
    els.accessoryPreview.style.display = "grid";
    els.accessoryNameEl.textContent = file.name;
    els.accessorySizeEl.textContent = formatBytes(file.size);
    els.accessoryStateEl.textContent = state;
    setDot(els.accessoryDotEl, dot);
  }
}
