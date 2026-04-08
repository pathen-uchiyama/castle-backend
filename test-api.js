const http = require('http');

http.get('http://localhost:3000/api/admin/live-wait-times', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log('Result count:', parsed.length);
      if (parsed.length > 0) {
        const withLL = parsed.filter(p => p.llType);
        console.log('Total with LL:', withLL.length);
        console.log('Sample LL:');
        console.log(JSON.stringify(withLL.slice(0, 3), null, 2));
      }
    } catch(e) { console.log('Error parsing:', e); }
  });
});
