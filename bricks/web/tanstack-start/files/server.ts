import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
// >>> stacky:server-init
// <<< stacky:server-init

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request)
  },
})
