// Use persisted board membership, never nickname/follower heuristics.
export function isIndependentStreamer(account){
 const boards=account?.boardKeys??[];
 const streamer=boards.includes('抖音主播板块')||account?.classification?.theme?.key==='douyin-streamers';
 const matrix=boards.some(key=>key!=='抖音主播板块'&&key.includes('矩阵'));
 return streamer&&!matrix;
}
export function matchesMatrixScope(account,{board='all',theme='all',tag='all'}={}){
 const explicitStreamers=board==='抖音主播板块'||theme==='douyin-streamers';
 return (explicitStreamers||!isIndependentStreamer(account))
  &&(board==='all'||account.boardKeys?.includes(board))
  &&(theme==='all'||account.classification?.theme?.key===theme)
  &&(tag==='all'||account.classification?.labels?.some(label=>label.key===tag));
}
