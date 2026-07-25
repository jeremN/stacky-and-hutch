<script>
let { children } = $props()
// >>> stacky:app-head
import '../app.css'
import Icon from '@iconify/svelte'
// <<< stacky:app-head
</script>

<header>
<!-- >>> stacky:app-shell -->
<Icon icon="ph:heart" />
<!-- <<< stacky:app-shell -->
</header>

{@render children()}
