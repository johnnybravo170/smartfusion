/**
 * Pure types for the contacts dedup flow. Lives in its own file so client
 * components can import them without accidentally dragging the server-only
 * supabase client into the client bundle via the sibling query module.
 */

export type ContactMatchStrength = 'strong' | 'weak';

export type ContactMatch = {
  id: string;
  name: string;
  kind: 'lead' | 'customer' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  email: string | null;
  phone: string | null;
  matchedOn: 'phone' | 'email' | 'name' | 'similar_name';
  strength: ContactMatchStrength;
  /** Trigram similarity (0.0–1.0). Only set for `similar_name` matches. */
  similarity?: number;
};
