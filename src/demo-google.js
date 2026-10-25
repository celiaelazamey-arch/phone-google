/**
 * Offline Google API provider for the free demo.
 * Mirrors the small surface of `googleapis` that src/google.js calls, so every
 * endpoint can be exercised with ZERO Google account, ZERO OAuth client and
 * ZERO network access. Never used outside demo mode.
 */
const isoIn = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

const MAIL = [
  {
    id: 'demo-mail-1',
    snippet: 'مرحبًا، أرسلنا لكم عرض الخدمات المطلوب...',
    payload: {
      headers: [
        { name: 'From', value: 'شركة النور <hello@example.com>' },
        { name: 'To', value: 'owner@example.com' },
        { name: 'Subject', value: 'طلب عرض خدمات' },
        { name: 'Date', value: new Date().toUTCString() }
      ]
    }
  },
  {
    id: 'demo-mail-2',
    snippet: 'Your monthly report is ready to view.',
    payload: {
      headers: [
        { name: 'From', value: 'reports@example.com' },
        { name: 'To', value: 'owner@example.com' },
        { name: 'Subject', value: 'Monthly report' },
        { name: 'Date', value: new Date(Date.now() - 86_400_000).toUTCString() }
      ]
    }
  }
];

const FILES = [
  { id: 'demo-file-1', name: 'دليل-الخدمات.pdf', mimeType: 'application/pdf', modifiedTime: isoIn(-2), webViewLink: '#' },
  { id: 'demo-file-2', name: 'عروض-الأسعار.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: isoIn(-26), webViewLink: '#' }
];

const CONTACTS = [
  { names: [{ displayName: 'أحمد مصطفى' }], phoneNumbers: [{ value: '+14155552671' }], emailAddresses: [{ value: 'ahmed@example.com' }] },
  { names: [{ displayName: 'Sara Ali' }], phoneNumbers: [{ value: '+14155552672' }], emailAddresses: [{ value: 'sara@example.com' }] }
];

export function createDemoGoogleApi() {
  const events = [
    { id: 'demo-event-1', summary: 'اجتماع متابعة المشروع', start: { dateTime: isoIn(24) }, end: { dateTime: isoIn(25) }, htmlLink: '#', status: 'confirmed' }
  ];

  return {
    gmail: () => ({
      users: {
        messages: {
          list: async () => ({ data: { messages: MAIL.map(({ id }) => ({ id })) } }),
          get: async ({ id }) => ({ data: MAIL.find((mail) => mail.id === id) || MAIL[0] })
        }
      }
    }),
    drive: () => ({
      files: {
        list: async ({ q }) => {
          const term = /name contains '([^']*)'/.exec(q || '')?.[1] || '';
          return { data: { files: FILES.filter((file) => !term || file.name.includes(term)) } };
        }
      }
    }),
    calendar: () => ({
      events: {
        list: async () => ({ data: { items: events } }),
        insert: async ({ requestBody }) => {
          const event = {
            id: `demo-event-${events.length + 1}`,
            summary: requestBody.summary,
            start: requestBody.start,
            end: requestBody.end,
            htmlLink: '#',
            status: 'confirmed'
          };
          events.unshift(event);
          return { data: event };
        }
      }
    }),
    people: () => ({
      people: {
        connections: {
          list: async () => ({ data: { connections: CONTACTS } })
        }
      }
    })
  };
}
