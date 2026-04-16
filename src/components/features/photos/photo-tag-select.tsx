'use client';

/**
 * Thin wrapper over shadcn Select bound to the photo tag enum. Used in the
 * upload form (one select per staged file) and in the metadata-edit flow.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type PhotoTag, photoTagLabels, photoTags } from '@/lib/validators/photo';

export function PhotoTagSelect({
  value,
  onChange,
  disabled,
  id,
  ariaLabel,
}: {
  value: PhotoTag;
  onChange: (tag: PhotoTag) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PhotoTag)} disabled={disabled}>
      <SelectTrigger id={id} className="w-[140px]" aria-label={ariaLabel ?? 'Photo tag'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {photoTags.map((t) => (
          <SelectItem key={t} value={t}>
            {photoTagLabels[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
