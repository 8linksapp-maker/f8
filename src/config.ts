/**
 * Configuração - tema Mivon Creative Agency (baseado em referência extraída)
 * Multi-Purpose portfolio / Creative agency
 */
export const siteConfig = {
  name: 'Mivon',
  siteName: 'Mivon',
  description: 'Mivon - Multi-Purpose portfolio HTML5 Template. Creating timeless brands that inspire.',
  siteDescription: 'Multi-Purpose portfolio & creative agency. Creating timeless brands that inspire.',
  url: 'https://meu-site.vercel.app',
  author: 'Mivon',
  primaryNiche: 'Creative Agency',
  secondaryNiche: 'Portfolio',
  tertiaryNiche: 'Branding',
  email: 'hello@Mivon.com',
  contactEmail: 'hello@Mivon.com',
  aboutDescription: 'Somos uma agência independente de design web e branding. Creating timeless brands that inspire.',
  social: {
    twitter: '#',
    linkedin: '#',
    facebook: '#',
    instagram: '#',
  },
  nav: [
    { label: 'Home', href: '/' },
    { label: 'Pages', href: '/about' },
    { label: 'Works', href: '/works' },
    { label: 'Blogs', href: '/blog' },
    { label: 'Contact Us', href: '/contact' },
  ],
  services: [
    { title: 'Product design', description: 'Curabitur mollis bibendum luctus.' },
    { title: 'Web design', description: 'Curabitur mollis bibendum luctus.' },
    { title: 'Seo & Marketing', description: 'Curabitur mollis bibendum luctus.' },
    { title: 'Branding', description: 'Curabitur mollis bibendum luctus.' },
  ],
  portfolio: [
    { title: 'Kantha', tags: ['Branding', 'Development'] },
    { title: 'Matts Studios', tags: ['Web design', 'Branding'] },
    { title: 'Inkzio Branding', tags: ['Branding', 'Mobile app'] },
    { title: 'Wizard illustrations', tags: ['Development', 'Social media'] },
  ],
  stats: [
    { value: '98%', label: 'Satisfied customers' },
    { value: '2k+', label: 'Product launch' },
    { value: '35+', label: 'Years experience' },
  ],
} as const;

export default siteConfig;
export const SITE_CONFIG = siteConfig;
