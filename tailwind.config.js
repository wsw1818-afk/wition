/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}', './src/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          50: '#f0e6ff',
          100: '#ddd6fe',
          200: '#c4b5fd',
          400: '#a78bfa',
          500: '#8B5CF6',
          600: '#7C3AED',
          700: '#6D28D9'
        }
      }
    }
  },
  plugins: []
}
