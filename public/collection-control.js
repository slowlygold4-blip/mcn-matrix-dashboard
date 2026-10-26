document.getElementById('open').addEventListener('click',async event=>{
 const button=event.currentTarget;button.disabled=true;
 const status=document.getElementById('status');status.textContent='正在创建仅此浏览器使用的管理连接…';
 try{const authResponse=await fetch('/api/auth/session');const auth=await authResponse.json();if(!authResponse.ok||!auth.csrfToken)throw Error('请先登录本机管理端');const response=await fetch('/api/collection-access',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrfToken},body:'{}'});const data=await response.json();if(!response.ok)throw Error(data.error||'连接失败');
 const url=new URL(data.url);if(url.origin!=='https://mcn-matrix-observatory.slowlygold4.chatgpt.site'||!/^#collection-access=[a-f0-9]{64}$/.test(url.hash))throw Error('连接校验失败');location.replace(url.href);
 }catch(error){status.textContent=error.message;button.disabled=false;}
});
