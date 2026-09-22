// Community filter lists. They are downloaded on the user's machine from their
// official sources and used unmodified. We never bundle or redistribute them
// (docs/LICENSING.md), and the popup credits each one.
export const COMMUNITY_LISTS = [
  {
    id: 'easylist',
    name: 'EasyList',
    homepage: 'https://easylist.to/',
    license: 'GPLv3 / CC BY-SA 3.0',
    urls: [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist-downloads.adblockplus.org/easylist.txt',
    ],
  },
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    homepage: 'https://easylist.to/',
    license: 'GPLv3 / CC BY-SA 3.0',
    urls: [
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://easylist-downloads.adblockplus.org/easyprivacy.txt',
    ],
  },
  {
    id: 'antiadblock',
    name: 'Adblock Warning Removal List',
    homepage: 'https://github.com/easylist/antiadblockfilters',
    license: 'GPLv3 / CC BY-SA 3.0',
    urls: ['https://easylist-downloads.adblockplus.org/antiadblockfilters.txt'],
  },
];

// Fetches a list, trying each mirror in turn. Throws if every mirror fails.
export async function downloadList(list) {
  const errors = [];
  for (const url of list.urls) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // A captive portal or error page is not a filter list.
      if (!/^\s*\[Adblock|^\s*!/.test(text)) throw new Error('not a filter list');
      return text;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}
