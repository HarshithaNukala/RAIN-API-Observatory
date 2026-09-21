/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        rain: {
          blue: '#2563eb',
          purple: '#7c3aed',
          dark: '#0f172a',
          light: '#f8fafc'
        }
      }
    },
  },
  plugins: [],
}
