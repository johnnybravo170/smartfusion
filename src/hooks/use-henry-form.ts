'use client';

/**
 * useHenryForm — registers a form with Henry's screen context so voice
 * dictation ("fill in my name, it's Mike Dawson") populates the fields
 * instead of going through a CRUD tool.
 *
 * Implementation note: the caller passes a fresh `reg` object every render
 * (new closures for setField/submit, new fields array). We register ONCE on
 * mount with a stable wrapper whose properties are getters pointing at a
 * ref — so Henry always reads the latest values without forcing the context
 * to re-render every time a field changes.
 */

import { useEffect, useRef } from 'react';
import { type HenryFormRegistration, useHenryScreen } from '@/lib/henry/screen-context';

export function useHenryForm(reg: HenryFormRegistration) {
  const { register, unregister } = useHenryScreen();

  // Always-fresh reference to whatever the caller passed this render.
  const regRef = useRef(reg);
  regRef.current = reg;

  useEffect(() => {
    const formId = regRef.current.formId;

    // Stable wrapper whose reads go through the ref. Registered once on
    // mount; unregistered on unmount.
    const stable: HenryFormRegistration = {
      formId,
      get title() {
        return regRef.current.title;
      },
      get fields() {
        return regRef.current.fields;
      },
      setField: (name, value) => regRef.current.setField(name, value),
      submit: () => regRef.current.submit?.(),
    };

    register(stable);
    return () => unregister(formId);
  }, [register, unregister]);
}
