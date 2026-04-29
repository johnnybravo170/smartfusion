'use client';

/**
 * TEMPORARY runtime probe — finds elements wider than the viewport and
 * renders the top offenders as a fixed-position banner. Used to track
 * down the "dashboard too wide on mobile" bug when static inspection
 * has failed multiple times. Remove this after the offender is fixed.
 */

import { useEffect, useState } from 'react';

type Offender = {
  tag: string;
  classes: string;
  text: string;
  right: number;
  left: number;
  width: number;
  selector: string;
};

function elementSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) part += `#${cur.id}`;
    if (cur.className && typeof cur.className === 'string') {
      const cls = cur.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (cls) part += `.${cls}`;
    }
    parts.unshift(part);
    cur = cur.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

export function OverflowProbe() {
  const [offenders, setOffenders] = useState<Offender[]>([]);
  const [vw, setVw] = useState(0);

  useEffect(() => {
    function probe() {
      const viewportWidth = window.innerWidth;
      const tolerance = 1;
      const found: Offender[] = [];
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > viewportWidth + tolerance) {
          const classes =
            typeof el.className === 'string'
              ? el.className
              : ((el as Element & { className?: { baseVal?: string } }).className?.baseVal ?? '');
          found.push({
            tag: el.tagName.toLowerCase(),
            classes: classes.toString().slice(0, 100),
            text: (el.textContent ?? '').trim().slice(0, 40),
            right: Math.round(rect.right),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            selector: elementSelector(el),
          });
        }
      }
      // Sort by furthest-overflowing first.
      found.sort((a, b) => b.right - a.right);
      setVw(viewportWidth);
      setOffenders(found.slice(0, 8));
    }
    // Wait a tick for layout to settle.
    const t = setTimeout(probe, 250);
    window.addEventListener('resize', probe);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', probe);
    };
  }, []);

  if (offenders.length === 0) {
    return (
      <div className="fixed bottom-2 left-2 z-[9999] rounded-md bg-emerald-600 px-2 py-1 text-[10px] text-white shadow-lg">
        no overflow @ {vw}px ✓
      </div>
    );
  }

  return (
    <div className="fixed bottom-2 left-2 right-2 z-[9999] max-h-[60vh] overflow-y-auto rounded-md bg-red-600 p-2 text-[10px] text-white shadow-lg">
      <div className="mb-1 font-bold">
        OVERFLOW @ {vw}px — {offenders.length} offenders
      </div>
      {offenders.map((o, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: temporary debug output, ranks by overflow
        <div key={`${i}-${o.selector}`} className="mb-1.5 border-t border-white/30 pt-1">
          <div className="font-mono">
            <b>#{i + 1}</b> {o.tag}{' '}
            <span className="text-yellow-200">
              right={o.right} left={o.left} w={o.width}
            </span>
          </div>
          <div className="font-mono text-yellow-100">{o.selector}</div>
          {o.classes ? <div className="font-mono opacity-70">.{o.classes}</div> : null}
          {o.text ? <div className="opacity-80">"{o.text}"</div> : null}
        </div>
      ))}
    </div>
  );
}
