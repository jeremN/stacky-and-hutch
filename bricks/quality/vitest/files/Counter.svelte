<script lang="ts">
  let count = $state(0)
</script>

<button onclick={() => (count += 1)}>count is {count}</button>
