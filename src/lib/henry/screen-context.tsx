'use client';

/**
 * Screen awareness for Henry.
 *
 * Forms (and eventually other interactive surfaces) can register themselves
 * with this context so Henry knows:
 *   - what the user is currently looking at
 *   - what fields are available
 *   - how to fill those fields
 *
 * Two new client-side tools read from this registry:
 *   - get_current_screen_context: returns the active form schema + route
 *   - fill_current_form: writes into registered setters
 *
 * Keeping this entirely client-side avoids a server round-trip per keystroke
 * and lets Henry drive React Hook Form (or any controlled form) directly.
 */

import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

export type HenryFieldType = 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'enum';

export type HenryFieldSchema = {
  /** Machine name (used in tool calls). Must match the key in the form state. */
  name: string;
  /** Human label for the model to reason about. */
  label: string;
  type: HenryFieldType;
  /** Optional hint shown to Henry about what a valid value looks like. */
  description?: string;
  /** For `type: 'enum'`, the allowed values. */
  options?: string[];
  /** Current value (so Henry can see what's already there). */
  currentValue?: string | number | null;
};

export type HenryFormRegistration = {
  /** Short identifier for the form, e.g. "customer-create". */
  formId: string;
  /** Short human description: "Creating a new customer". */
  title: string;
  fields: HenryFieldSchema[];
  /** Called by fill_current_form. Return true if the field was accepted. */
  setField: (name: string, value: string) => boolean;
  /** Optional: called when Henry invokes submit_current_form. */
  submit?: () => void;
};

type ScreenContextValue = {
  route: string;
  form: HenryFormRegistration | null;
  register: (reg: HenryFormRegistration) => void;
  unregister: (formId: string) => void;
};

const ScreenContext = createContext<ScreenContextValue | null>(null);

export function HenryScreenProvider({ children }: { children: ReactNode }) {
  // usePathname keeps `route` in sync with navigations automatically.
  const route = usePathname() ?? '/';
  const [form, setForm] = useState<HenryFormRegistration | null>(null);
  // Track the most recently registered formId so unregister is idempotent
  // (guards against the mount/unmount ordering of two forms in rapid nav).
  const activeIdRef = useRef<string | null>(null);

  const register = useCallback((reg: HenryFormRegistration) => {
    activeIdRef.current = reg.formId;
    setForm(reg);
  }, []);

  const unregister = useCallback((formId: string) => {
    if (activeIdRef.current === formId) {
      activeIdRef.current = null;
      setForm(null);
    }
  }, []);

  const value = useMemo(
    () => ({ route, form, register, unregister }),
    [route, form, register, unregister],
  );

  return <ScreenContext.Provider value={value}>{children}</ScreenContext.Provider>;
}

export function useHenryScreen(): ScreenContextValue {
  const ctx = useContext(ScreenContext);
  if (!ctx) throw new Error('useHenryScreen must be used within HenryScreenProvider');
  return ctx;
}
