'use client';

/**
 * TEMPORARY runtime probe — finds elements wider than the viewport and
 * renders the top offenders as a fixed-position banner. Used to track
 * down the "dashboard too wide on mobile" bug when static inspection
 * has failed multiple times. Remove this after the offender is fixed.
 */

import { useEffect, useState } from 'react';

type Offender = {
  kind: 'page' | 'clip';
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
  const [docScroll, setDocScroll] = useState(0);

  useEffect(() => {
    function nearestClippingAncestor(el: Element): Element | null {
      let cur: Element | null = el.parentElement;
      while (cur && cur !== document.documentElement) {
        const cs = window.getComputedStyle(cur);
        if (
          cs.overflowX === 'hidden' ||
          cs.overflowX === 'clip' ||
          cs.overflow === 'hidden' ||
          cs.overflow === 'clip'
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }

    function probe() {
      const viewportWidth = window.innerWidth;
      const docScrollWidth = document.documentElement.scrollWidth;
      const tolerance = 1;
      const seen = new Set<Element>();
      const found: Offender[] = [];
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right <= viewportWidth + tolerance) continue;

        // Skip intentional clipping (truncate/ellipsis spans).
        const classes =
          typeof el.className === 'string'
            ? el.className
            : ((el as Element & { className?: { baseVal?: string } }).className?.baseVal ?? '');
        const cs = window.getComputedStyle(el);
        const intentionalSelf =
          cs.textOverflow === 'ellipsis' ||
          cs.overflowX === 'scroll' ||
          cs.overflowX === 'auto' ||
          cs.overflow === 'scroll' ||
          cs.overflow === 'auto' ||
          classes.toString().includes('truncate') ||
          classes.toString().includes('line-clamp');
        if (intentionalSelf) continue;

        // Find the nearest ancestor that's actually clipping. If the element
        // extends past that ancestor, the user sees content cut off — that's
        // the real "too wide" symptom even when the document doesn't scroll.
        const clipper = nearestClippingAncestor(el);
        const clipperRect = clipper?.getBoundingClientRect();
        const kind: Offender['kind'] =
          clipper && clipperRect
            ? rect.right > clipperRect.right + tolerance
              ? 'clip'
              : null!
            : 'page';
        if (!kind) continue;

        if (!seen.has(el)) {
          seen.add(el);
          found.push({
            kind,
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
      // Sort outermost-first (smallest left, then deepest tree position) so
      // the actual root offender shows at the top — descendants of a wide
      // ancestor will all also be wide, but only the ancestor needs fixing.
      found.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'page' ? -1 : 1;
        // Smaller left = outermost in the layout chain
        if (Math.abs(a.left - b.left) > 4) return a.left - b.left;
        return b.right - a.right;
      });
      setVw(viewportWidth);
      setDocScroll(Math.max(0, docScrollWidth - viewportWidth));
      setOffenders(found.slice(0, 8));
    }
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
        no overflow @ {vw}px (doc +{docScroll}px) ✓
      </div>
    );
  }

  return (
    <div className="fixed bottom-2 left-2 right-2 z-[9999] max-h-[60vh] overflow-y-auto rounded-md bg-red-600 p-2 text-[10px] text-white shadow-lg">
      <div className="mb-1 font-bold">
        OVERFLOW @ {vw}px — {offenders.length} offenders (doc +{docScroll}px)
      </div>
      {offenders.map((o, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: temporary debug output, ranks by overflow
        <div key={`${i}-${o.selector}`} className="mb-1.5 border-t border-white/30 pt-1">
          <div className="font-mono">
            <b>#{i + 1}</b> [{o.kind}] {o.tag}{' '}
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
