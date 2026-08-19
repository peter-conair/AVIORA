/**
 * GLOBAL knowledge seed (tenant_id NULL) — the spec §74 journey:
 *   Better Sleep → Sleep Hygiene → educational article → Magnesium → products.
 *
 * Deliberately TWO brands so brand neutrality is provable: adding the second
 * one is rows, not a schema change (spec §31), and nothing downstream ranks or
 * branches on a specific brand.
 */
export interface KnowledgeSeed {
  healthGoals: Array<{ code: string; name: string; description: string; order: number }>;
  topics: Array<{ code: string; name: string; summary: string; goals: string[] }>;
  ingredients: Array<{
    code: string;
    name: string;
    summary: string;
    safetyNotes: string;
    topics: string[];
  }>;
  articles: Array<{
    slug: string;
    title: string;
    summary: string;
    body: string;
    topics: string[];
    ingredients: string[];
  }>;
  evidence: Array<{
    ingredient: string;
    title: string;
    source: string;
    url: string;
    summary: string;
  }>;
  brands: Array<{ code: string; name: string }>;
  products: Array<{
    code: string;
    brand: string;
    name: string;
    description: string;
    sourceUrl: string;
    safetyNotes: string;
    ingredients: string[];
  }>;
}

export const KNOWLEDGE_SEED: KnowledgeSeed = {
  healthGoals: [
    {
      code: 'better-sleep',
      name: 'Better Sleep',
      description: 'Fall asleep more easily and wake up rested.',
      order: 1,
    },
    {
      code: 'daily-energy',
      name: 'Daily Energy',
      description: 'Steadier energy through the day without relying on stimulants.',
      order: 2,
    },
  ],
  topics: [
    {
      code: 'sleep-hygiene',
      name: 'Sleep Hygiene',
      summary: 'The daily habits and environment that make good sleep likely.',
      goals: ['better-sleep'],
    },
    {
      code: 'evening-nutrition',
      name: 'Evening Nutrition',
      summary: 'How the timing and content of evening meals affects sleep quality.',
      goals: ['better-sleep', 'daily-energy'],
    },
  ],
  ingredients: [
    {
      code: 'magnesium',
      name: 'Magnesium',
      summary:
        'A mineral involved in muscle relaxation and normal nervous-system function. Commonly obtained from leafy greens, nuts, seeds and whole grains.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['sleep-hygiene', 'evening-nutrition'],
    },
    {
      code: 'l-theanine',
      name: 'L-Theanine',
      summary:
        'An amino acid found naturally in tea leaves, often discussed in the context of relaxation without sedation.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. Consult a qualified healthcare professional before use if pregnant, nursing, or taking medication.',
      topics: ['sleep-hygiene'],
    },
  ],
  articles: [
    {
      slug: 'winding-down-an-evening-routine-that-works',
      title: 'Winding Down: An Evening Routine That Works',
      summary:
        'A practical, product-free routine for the two hours before bed, and where nutrition fits in.',
      body: [
        'Good sleep is built during the day, not in the last ten minutes before bed.',
        '',
        'Start with light: dim the room and step away from bright screens about an hour before you plan to sleep. Keep the bedroom cool and dark, and keep a consistent wake time — even on weekends, since the wake time anchors the whole rhythm.',
        '',
        'Evening nutrition matters more than most people expect. Large late meals, alcohol, and caffeine after mid-afternoon all fragment sleep. A lighter evening meal a few hours before bed gives digestion time to settle.',
        '',
        'Several nutrients come up in conversations about relaxation and sleep — magnesium and L-theanine among them. Food sources come first: leafy greens, nuts, seeds, whole grains, and tea are ordinary places these appear. Supplementation is a personal decision best discussed with a qualified healthcare professional, especially alongside medication.',
        '',
        'None of this is a treatment for a sleep disorder. Persistent sleep problems deserve a conversation with a doctor.',
      ].join('\n'),
      topics: ['sleep-hygiene', 'evening-nutrition'],
      ingredients: ['magnesium', 'l-theanine'],
    },
  ],
  evidence: [
    {
      ingredient: 'magnesium',
      title: 'Magnesium — Fact Sheet for Health Professionals',
      source: 'NIH Office of Dietary Supplements',
      url: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
      summary: 'Reference overview of dietary sources, intake levels, and interactions.',
    },
  ],
  brands: [
    { code: 'brand-a', name: 'Northline Naturals' },
    { code: 'brand-b', name: 'Verda Wellness' },
  ],
  products: [
    {
      code: 'northline-magnesium-glycinate',
      brand: 'brand-a',
      name: 'Magnesium Glycinate 200mg',
      description: 'A magnesium supplement in the glycinate form.',
      sourceUrl: 'https://example.com/northline/magnesium-glycinate',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['magnesium'],
    },
    {
      code: 'verda-magnesium-citrate',
      brand: 'brand-b',
      name: 'Magnesium Citrate 150mg',
      description: 'A magnesium supplement in the citrate form.',
      sourceUrl: 'https://example.com/verda/magnesium-citrate',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['magnesium'],
    },
    {
      code: 'verda-calm-blend',
      brand: 'brand-b',
      name: 'Evening Calm Blend',
      description: 'A blend containing L-theanine and magnesium.',
      sourceUrl: 'https://example.com/verda/evening-calm',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['l-theanine', 'magnesium'],
    },
  ],
};
