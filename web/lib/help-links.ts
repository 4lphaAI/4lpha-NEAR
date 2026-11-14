/** Guide and tutorial video links on the deploy pages (operator, 2026-11-14). The paper meme agent has a guide but no video yet. */
export const HEADER_TUTORIAL = 'https://youtu.be/LiskEYE7MjE';

export const HELP_LINKS: Record<'grid' | 'lp' | 'schedule' | 'dca' | 'degen', { guide: string; video?: string }> = {
  grid: { guide: 'https://docs.4lpha.tech/NEAR#grid', video: 'https://youtu.be/oqsXoihV0O8' },
  lp: { guide: 'https://docs.4lpha.tech/NEAR#lp', video: 'https://youtu.be/1V9U_7v7kc4' },
  schedule: { guide: 'https://docs.4lpha.tech/NEAR#schedule', video: 'https://youtu.be/DCbxlC-sVyQ' },
  dca: { guide: 'https://docs.4lpha.tech/NEAR#dca', video: 'https://youtu.be/PIz6a1rvetw' },
  degen: { guide: 'https://docs.4lpha.tech/NEAR#meme' },
};
