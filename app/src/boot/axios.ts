import axios from 'axios'
import { boot } from 'quasar/wrappers'

axios.defaults.headers.common['ngrok-skip-browser-warning'] = '1'

export default boot(({ app }) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  app.config.globalProperties.$axios = axios
})
