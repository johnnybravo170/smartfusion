'use client';

/**
 * Searchable customer combobox using shadcn Command + Popover.
 * Filters client-side as you type. Scales to hundreds of customers.
 */

import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type CustomerPickerProps = {
  customers: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  error?: string;
};

export function CustomerPicker({
  customers,
  value,
  onChange,
  placeholder = 'Pick a customer',
  error,
}: CustomerPickerProps) {
  const [open, setOpen] = useState(false);

  const selected = customers.find((c) => c.id === value);

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id === value ? '' : id);
      setOpen(false);
    },
    [onChange, value],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange('');
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'w-full justify-between font-normal',
              !selected && 'text-muted-foreground',
              error && 'border-destructive',
            )}
          >
            <span className="truncate">{selected ? selected.name : placeholder}</span>
            <span className="ml-2 flex shrink-0 items-center gap-1">
              {selected && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={handleClear}
                  className="rounded-sm p-0.5 hover:bg-muted"
                  aria-label="Clear customer"
                >
                  <X className="size-3.5 opacity-50" />
                </button>
              )}
              <ChevronsUpDown className="size-4 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search customers..." />
            <CommandList>
              <CommandEmpty>No customers found.</CommandEmpty>
              <CommandGroup>
                {customers.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.name}
                    onSelect={() => handleSelect(c.id)}
                    data-checked={c.id === value}
                  >
                    <Check
                      className={cn('mr-2 size-4', c.id === value ? 'opacity-100' : 'opacity-0')}
                    />
                    {c.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
