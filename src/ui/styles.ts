// Replaced with the compiled, scoped CSS by the existing JS-only bundle build.
declare const __VISHVAKARMA_CSS__: string;
export function installStyles() {
  const id = 'vishvakarma-plugin-ui-style';
  const style = document.createElement('style');
  style.id = id; style.textContent = __VISHVAKARMA_CSS__;
  document.getElementById(id)?.remove(); document.head.append(style);
  // Remove this exact node: an old HMR instance must not remove its replacement.
  return () => style.remove();
}
