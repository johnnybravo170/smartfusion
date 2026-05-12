export const customerViewModes = ['lump_sum', 'sections', 'categories', 'detailed'] as const;
export type CustomerViewMode = (typeof customerViewModes)[number];
