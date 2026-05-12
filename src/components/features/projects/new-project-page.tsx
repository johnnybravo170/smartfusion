'use client';

/**
 * Client wrapper for /projects/new — owns the parsed-intake state so
 * the IntakeAccelerator (drop a quote / voice memo / paste a blurb)
 * can pre-fill the ProjectForm fields below it. Both surfaces live on
 * one page; either path produces the same project create.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { IntakeAccelerator } from '@/components/features/projects/intake-accelerator';
import {
  ProjectForm,
  type ProjectFormCustomerOption,
  type ProjectFormDefaults,
  type ProjectFormSuggestions,
} from '@/components/features/projects/project-form';
import type { ParsedIntake } from '@/lib/ai/intake-prompt';
import type { ProjectInput } from '@/lib/validators/project';
import type { ProjectActionResult } from '@/server/actions/projects';

export function NewProjectFormSurface({
  customers,
  action,
  defaults,
}: {
  customers: ProjectFormCustomerOption[];
  action: (input: ProjectInput & { id?: string }) => Promise<ProjectActionResult>;
  defaults?: ProjectFormDefaults;
}) {
  const [suggestions, setSuggestions] = useState<ProjectFormSuggestions | undefined>(undefined);

  function handleParsed(parsed: ParsedIntake) {
    // Translate ParsedIntake → ProjectFormSuggestions. We pull the
    // customer name (fuzzy-matched downstream against existing
    // contacts), project name, and description. Categories / scope /
    // reply draft are intentionally not surfaced here — the operator
    // can build scope on the budget tab post-creation. If they need
    // the deeper guided flow (scope review, reply drafting), the
    // /projects/new?intake=full route still serves it.
    setSuggestions({
      customer_name: parsed.customer.name,
      name: parsed.project.name,
      description: parsed.project.description,
    });
  }

  function handleUnmatchedCustomer(name: string) {
    toast(`Customer "${name}" doesn't exist yet`, {
      description: 'Pick from the dropdown below or click "+ New customer" to create them.',
    });
  }

  return (
    <div className="space-y-6">
      <IntakeAccelerator onParsed={handleParsed} />
      <ProjectForm
        mode="create"
        customers={customers}
        defaults={defaults}
        action={action}
        suggestions={suggestions}
        onUnmatchedCustomer={handleUnmatchedCustomer}
      />
    </div>
  );
}
