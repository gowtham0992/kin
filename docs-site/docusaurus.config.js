const docsUrl = process.env.KIN_DOCS_URL || 'https://gowtham0992.github.io';
const docsBaseUrl = process.env.KIN_DOCS_BASE_URL || '/kin/';
const parsedUrl = new URL(docsUrl);
if (parsedUrl.protocol !== 'https:' || parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash || parsedUrl.username || parsedUrl.password) {
  throw new Error('KIN_DOCS_URL must be an HTTPS origin without credentials, path, query or fragment.');
}
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(docsBaseUrl)) {
  throw new Error('KIN_DOCS_BASE_URL must be a slash-delimited path with a trailing slash.');
}

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Kin',
  tagline: 'Everyday care, shared across households.',
  favicon: 'img/kin-icon.png',
  url: parsedUrl.origin,
  baseUrl: docsBaseUrl,
  organizationName: 'gowtham0992',
  projectName: 'kin',
  trailingSlash: true,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',
  markdown: {hooks: {onBrokenMarkdownLinks: 'throw'}},
  i18n: {defaultLocale: 'en', locales: ['en']},
  // Publish only these curated pages. Historical repository docs are not inputs.
  presets: [['classic', {
    docs: {
      path: 'content',
      routeBasePath: '/',
      sidebarPath: require.resolve('./sidebars.js'),
      include: ['intro.mdx', 'quickstart.md', 'family-workspace.md', 'echo-and-mcp.md', 'privacy-and-safety.md', 'for-developers.md'],
      showLastUpdateAuthor: false,
      showLastUpdateTime: false,
    },
    blog: false,
    pages: false,
    theme: {customCss: require.resolve('./src/css/custom.css')},
  }]],
  themeConfig: {
    colorMode: {defaultMode: 'light', disableSwitch: true, respectPrefersColorScheme: false},
    navbar: {
      title: 'Kin',
      logo: {alt: 'Kin care-circle mark', src: 'img/kin-icon.png', width: 36, height: 36},
      items: [
        {type: 'docSidebar', sidebarId: 'guides', label: 'Documentation', position: 'left'},
        {href: 'https://kin.gowthamsarveswaran.com/', label: 'Open Kin', position: 'right'},
      ],
    },
    docs: {sidebar: {hideable: false}},
    footer: {
      style: 'light',
      links: [{title: 'Kin', items: [
        {label: 'Meet Kin', href: 'https://kin.gowthamsarveswaran.com/'},
        {label: 'Privacy and safety', to: '/privacy-and-safety/'},
      ]}],
      copyright: '© 2026 Gowtham Sarveswaran. Everyday care, shared. Not emergency monitoring or medical advice.',
    },
    tableOfContents: {minHeadingLevel: 2, maxHeadingLevel: 3},
    metadata: [{name: 'referrer', content: 'strict-origin-when-cross-origin'}],
  },
};

module.exports = config;
