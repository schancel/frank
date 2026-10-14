import axios from 'axios'
import { defineBoot as boot } from '@quasar/app-vite'

axios.defaults.headers.common['ngrok-skip-browser-warning'] = '1'

export default boot(({ app }) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  app.config.globalProperties.$axios = axios
})
