/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        theme: 'var(--radius)',
      },
      colors: {
        theme: {
          page: 'var(--page-bg)',
          card: 'var(--card-bg)',
          border: 'var(--border)',
          text: 'var(--text)',
          muted: 'var(--muted)',
          accent: 'var(--accent)',
          'accent-text': 'var(--accent-text)',
          link: 'var(--link)',
          pass: 'var(--pass)',
          'pass-bg': 'var(--pass-bg)',
          warn: 'var(--warn)',
          'warn-bg': 'var(--warn-bg)',
          fail: 'var(--fail)',
          'fail-bg': 'var(--fail-bg)',
          info: 'var(--info)',
          'info-bg': 'var(--info-bg)',
        },
        brand: {
          50: '#eef6ff',
          100: '#d9ebff',
          200: '#bcddfe',
          300: '#8ec6fd',
          400: '#59a6fa',
          500: '#3383f5',
          600: '#1f65ea',
          700: '#184fcf',
          800: '#1a41a6',
          900: '#1a3a82',
          950: '#10234f',
        },
        slatex: {
          950: '#0b1220',
        },
        navy: '#0B1F4F',
        amber: {
          450: '#F5A623',
        },
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.06)',
        'card-hover': '0 12px 28px -4px rgb(15 23 42 / 0.12), 0 2px 6px -2px rgb(15 23 42 / 0.08)',
      },
    },
  },
  plugins: [],
}
