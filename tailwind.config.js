/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    screens: {
      xs: '320px',
      sm: '640px',
      lg: '1024px',
      xl: '1200px',
    },
    extend: {
      fontFamily: {
        roboto: ['Roboto', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        'primary-blue': {
          DEFAULT: '#00468b',
          50: '#e6edf4',
          100: '#ccdbe8',
          200: '#99b7d1',
          300: '#6693ba',
          400: '#336fa3',
          500: '#00468b',
          600: '#003f7d',
          700: '#00366a',
          800: '#002c57',
          900: '#001d3a',
        },
        body: '#292929',
        alert: {
          critical: '#d32f2f',
          warning: '#ed6c02',
          success: '#2e7d32',
          info: '#0288d1',
        },
      },
    },
  },
  plugins: [],
};