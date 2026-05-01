"use client"

import * as React from "react"
import { Label as LabelPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * shadcn Label — primitive `<label>` with shared text/disabled styles.
 *
 * The default `mb-1.5` adds bottom margin so labels stacked above inputs
 * (the dominant form-field pattern) have breathing room without every
 * caller having to remember the convention. Inline cases where Label
 * sits next to its input on the same row should pass `className="mb-0"`
 * to opt out — but the much more common stacked-form pattern works
 * automatically.
 *
 * `flex items-center gap-2` stays as the default so Label can still wrap
 * a Checkbox + text inline. tailwind-merge resolves caller overrides.
 */
function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "mb-1.5 flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
