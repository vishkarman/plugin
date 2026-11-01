import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile } from 'node:fs/promises';

export async function buildUiCss() {
  const file = new URL('../src/ui/styles.css', import.meta.url);
  const result = await postcss([tailwind({ optimize: false })]).process(await readFile(file, 'utf8'), { from: file.pathname });
  const root = postcss.parse(result.css.replaceAll('--tw-', '--vkp-tw-'));
  // DSH owns layer order. Flatten only our generated CSS, never insert a global
  // layer declaration or Preflight. Scope theme defaults and every utility.
  root.walkAtRules('layer', rule => { if (rule.nodes) rule.replaceWith(...rule.nodes); else rule.remove(); });
  root.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    if (rule.selector.startsWith('&')) return; // Nested state inherits its scoped parent.
    const selectors = postcss.list.comma(rule.selector);
    rule.selector = [...new Set(selectors.flatMap(selector => {
      if (selector.includes('.vishvakarma-plugin-ui')) return selector;
      if (selector === ':root' || selector === ':host') return '.vishvakarma-plugin-ui';
      return [`.vishvakarma-plugin-ui${selector.startsWith('.') ? selector : ` ${selector}`}`, `.vishvakarma-plugin-ui ${selector}`];
    }))].join(', ');
  });
  const css = root.toString();
  if (/(^|[;}])\s*(?:body|:root|:host)\s*[{,]/m.test(css) || /@layer\b|--tw-/.test(css)) throw new Error('Plugin CSS escaped its namespace');
  return css;
}
