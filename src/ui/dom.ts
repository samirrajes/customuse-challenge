export function getDom() {
  const wrap = document.getElementById("canvasWrap") as HTMLDivElement;

  const avatarInput = document.getElementById("avatarInput") as HTMLInputElement;
  const accessoryInput = document.getElementById("accessoryInput") as HTMLInputElement;
  const downloadBtn = document.getElementById("downloadBtn") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;

  const avatarDrop = document.getElementById("avatarDrop") as HTMLDivElement;
  const accessoryDrop = document.getElementById("accessoryDrop") as HTMLDivElement;

  const avatarBrowseBtn = document.getElementById("avatarBrowseBtn") as HTMLButtonElement;
  const accessoryBrowseBtn = document.getElementById("accessoryBrowseBtn") as HTMLButtonElement;

  const avatarPreview = document.getElementById("avatarPreview") as HTMLDivElement;
  const accessoryPreview = document.getElementById("accessoryPreview") as HTMLDivElement;

  const avatarNameEl = document.getElementById("avatarName") as HTMLDivElement;
  const avatarSizeEl = document.getElementById("avatarSize") as HTMLSpanElement;
  const avatarStateEl = document.getElementById("avatarState") as HTMLSpanElement;
  const avatarDotEl = document.getElementById("avatarDot") as HTMLSpanElement;

  const accessoryNameEl = document.getElementById("accessoryName") as HTMLDivElement;
  const accessorySizeEl = document.getElementById("accessorySize") as HTMLSpanElement;
  const accessoryStateEl = document.getElementById("accessoryState") as HTMLSpanElement;
  const accessoryDotEl = document.getElementById("accessoryDot") as HTMLSpanElement;

  return {
    wrap,
    avatarInput, accessoryInput, downloadBtn, statusEl,
    avatarDrop, accessoryDrop,
    avatarBrowseBtn, accessoryBrowseBtn,
    avatarPreview, accessoryPreview,
    avatarNameEl, avatarSizeEl, avatarStateEl, avatarDotEl,
    accessoryNameEl, accessorySizeEl, accessoryStateEl, accessoryDotEl,
  };
}
