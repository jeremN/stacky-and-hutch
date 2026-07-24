// >>> stacky:server-init
// <<< stacky:server-init

export default {
  fetch(_request: Request): Response {
    return new Response('ok')
  },
}
