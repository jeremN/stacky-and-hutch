<script>
import { createQuery } from '@tanstack/svelte-query'

const query = createQuery(() => ({
  queryKey: ['demo'],
  queryFn: async () => 'ok',
}))
</script>

<p>{query.isSuccess ? query.data : 'loading…'}</p>
