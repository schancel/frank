<template>
  <Teleport to="body" v-if="isClient">
    <Transition name="mermaid-modal-fade">
      <div
        v-if="isOpen"
        class="mermaid-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Diagram Viewer"
        @click.self="closeModal"
      >
        <div class="mermaid-modal-container">
          <!-- Header Bar -->
          <div class="mermaid-modal-header">
            <div class="mermaid-modal-title">
              <span class="mermaid-modal-icon">🔍</span>
              <span>Protocol Diagram Viewer</span>
              <span class="mermaid-modal-hint"
                >(Drag to pan • Scroll to zoom)</span
              >
            </div>

            <!-- Controls Toolbar -->
            <div class="mermaid-modal-toolbar">
              <button
                type="button"
                class="mermaid-btn"
                title="Zoom Out (-)"
                @click="zoomOut"
                :disabled="scale <= 0.25"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>

              <span class="mermaid-zoom-indicator"
                >{{ Math.round(scale * 100) }}%</span
              >

              <button
                type="button"
                class="mermaid-btn"
                title="Zoom In (+)"
                @click="zoomIn"
                :disabled="scale >= 5.0"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>

              <button
                type="button"
                class="mermaid-btn"
                title="Reset to 100% (0)"
                @click="resetZoom"
              >
                Reset
              </button>

              <button
                type="button"
                class="mermaid-btn"
                :title="copied ? 'Copied to clipboard!' : 'Copy SVG code'"
                @click="copySvg"
              >
                {{ copied ? "✓ Copied" : "Copy SVG" }}
              </button>

              <button
                type="button"
                class="mermaid-btn mermaid-btn-close"
                title="Close (Esc)"
                @click="closeModal"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <!-- Canvas Viewport with Pan & Zoom -->
          <div
            ref="viewportRef"
            class="mermaid-modal-viewport"
            :class="{ 'is-dragging': isDragging }"
            @mousedown="onMouseDown"
            @mousemove="onMouseMove"
            @mouseup="onMouseUp"
            @mouseleave="onMouseUp"
            @touchstart="onTouchStart"
            @touchmove="onTouchMove"
            @touchend="onTouchEnd"
            @wheel="onWheel"
          >
            <div
              class="mermaid-modal-canvas"
              :style="{
                transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
                transformOrigin: 'center center',
              }"
              v-html="svgContent"
            ></div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const isClient = ref(false);
const isOpen = ref(false);
const svgContent = ref("");
const rawSvgString = ref("");
const scale = ref(1.0);
const translateX = ref(0);
const translateY = ref(0);
const isDragging = ref(false);
const startX = ref(0);
const startY = ref(0);
const copied = ref(false);
const viewportRef = ref<HTMLElement | null>(null);

function openModal(svgEl: SVGSVGElement) {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;

  // Extract natural dimensions from viewBox if present
  const viewBox = clone.getAttribute("viewBox");
  let naturalWidth = 0;
  let naturalHeight = 0;
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/);
    if (parts.length === 4) {
      naturalWidth = parseFloat(parts[2]);
      naturalHeight = parseFloat(parts[3]);
    }
  }

  // Remove restrictive inline max-width and set unconstrained SVG rendering
  clone.style.maxWidth = "none";
  clone.style.maxHeight = "none";
  clone.style.height = "auto";

  if (naturalWidth > 0) {
    clone.setAttribute("width", `${naturalWidth}px`);
    if (naturalHeight > 0) {
      clone.setAttribute("height", `${naturalHeight}px`);
    }
  }

  svgContent.value = clone.outerHTML;
  rawSvgString.value = svgEl.outerHTML;

  // Reset positioning and start with readable 1.1x scaling
  scale.value = 1.1;
  translateX.value = 0;
  translateY.value = 0;
  isOpen.value = true;

  if (typeof document !== "undefined") {
    document.body.style.overflow = "hidden";
  }
}

function closeModal() {
  isOpen.value = false;
  isDragging.value = false;
  if (typeof document !== "undefined") {
    document.body.style.overflow = "";
  }
}

function zoomIn() {
  scale.value = Math.min(Number((scale.value + 0.25).toFixed(2)), 5.0);
}

function zoomOut() {
  scale.value = Math.max(Number((scale.value - 0.25).toFixed(2)), 0.25);
}

function resetZoom() {
  scale.value = 1.0;
  translateX.value = 0;
  translateY.value = 0;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
  const newScale = Math.min(Math.max(scale.value * zoomFactor, 0.25), 5.0);
  scale.value = Number(newScale.toFixed(2));
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  isDragging.value = true;
  startX.value = e.clientX - translateX.value;
  startY.value = e.clientY - translateY.value;
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value) return;
  translateX.value = e.clientX - startX.value;
  translateY.value = e.clientY - startY.value;
}

function onMouseUp() {
  isDragging.value = false;
}

function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 1) {
    isDragging.value = true;
    startX.value = e.touches[0].clientX - translateX.value;
    startY.value = e.touches[0].clientY - translateY.value;
  }
}

function onTouchMove(e: TouchEvent) {
  if (!isDragging.value || e.touches.length !== 1) return;
  translateX.value = e.touches[0].clientX - startX.value;
  translateY.value = e.touches[0].clientY - startY.value;
}

function onTouchEnd() {
  isDragging.value = false;
}

async function copySvg() {
  if (!rawSvgString.value || typeof navigator === "undefined") return;
  try {
    await navigator.clipboard.writeText(rawSvgString.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error("Failed to copy SVG:", err);
  }
}

function handleDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // If clicked inside the modal dialog, ignore
  if (target.closest(".mermaid-modal-container")) return;

  const mermaidContainer = target.closest(".mermaid");
  if (mermaidContainer) {
    const svg = mermaidContainer.querySelector("svg");
    if (svg) {
      e.preventDefault();
      openModal(svg as unknown as SVGSVGElement);
    }
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (!isOpen.value) return;
  if (e.key === "Escape") {
    closeModal();
  } else if (e.key === "+" || e.key === "=") {
    zoomIn();
  } else if (e.key === "-") {
    zoomOut();
  } else if (e.key === "0") {
    resetZoom();
  }
}

onMounted(() => {
  isClient.value = true;
  document.addEventListener("click", handleDocClick);
  window.addEventListener("keydown", handleKeyDown);
});

onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener("click", handleDocClick);
    document.body.style.overflow = "";
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", handleKeyDown);
  }
});
</script>

<style scoped>
.mermaid-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.78);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  padding: 1.5rem;
}

.mermaid-modal-container {
  display: flex;
  flex-direction: column;
  width: 96vw;
  max-width: 1500px;
  height: 92vh;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.mermaid-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-border);
  user-select: none;
}

.mermaid-modal-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--vp-c-text-1);
}

.mermaid-modal-icon {
  font-size: 1.1rem;
}

.mermaid-modal-hint {
  font-size: 0.8rem;
  font-weight: normal;
  color: var(--vp-c-text-3);
  margin-left: 0.5rem;
}

.mermaid-modal-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mermaid-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.35rem 0.65rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mermaid-btn:hover:not(:disabled) {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.mermaid-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.mermaid-btn-close {
  margin-left: 0.5rem;
  color: var(--vp-c-text-2);
}

.mermaid-btn-close:hover {
  color: #ef4444 !important;
  border-color: #ef4444 !important;
}

.mermaid-zoom-indicator {
  min-width: 3.5rem;
  text-align: center;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
}

.mermaid-modal-viewport {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--vp-c-bg-alt);
  cursor: grab;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mermaid-modal-viewport.is-dragging {
  cursor: grabbing;
}

.mermaid-modal-canvas {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.05s ease-out;
  padding: 2.5rem;
}

.mermaid-modal-canvas :deep(svg) {
  max-width: none !important;
  max-height: none !important;
  display: block;
}

.mermaid-modal-fade-enter-active,
.mermaid-modal-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.mermaid-modal-fade-enter-from,
.mermaid-modal-fade-leave-to {
  opacity: 0;
}
</style>
