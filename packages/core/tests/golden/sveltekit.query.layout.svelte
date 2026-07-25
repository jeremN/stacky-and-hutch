<script>
let { children } = $props()
// >>> stacky:app-head
import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query'
setQueryClientContext(new QueryClient())
// <<< stacky:app-head
</script>

<header>
<!-- >>> stacky:app-shell -->
<!-- <<< stacky:app-shell -->
</header>

{@render children()}
