/**
 * Built-in starter templates for the renovation vertical.
 *
 * Adding a new one: write the JSON file, import it here, push it
 * onto the export. No registry / migration needed — the seed action
 * looks up the slug at apply time.
 */

import basementBuild from './basement-build.json';
import bathroomStandard from './bathroom-reno-standard.json';
import deckStandard from './deck-build-standard.json';
import kitchenStandard from './kitchen-reno-standard.json';
import type { StarterTemplate } from './types';
import wholeHomeReno from './whole-home-reno.json';

export const STARTER_TEMPLATES: StarterTemplate[] = [
  bathroomStandard as StarterTemplate,
  kitchenStandard as StarterTemplate,
  basementBuild as StarterTemplate,
  deckStandard as StarterTemplate,
  wholeHomeReno as StarterTemplate,
];

export function findStarterTemplate(slug: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
