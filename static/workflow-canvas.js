'use strict';

// Presentation only: every edge and every card is supplied by the graph API.
(function(root) {
  const CARD_WIDTH = 246, CARD_HEIGHT = 112, RANK_GAP = 150, SIBLING_GAP = 280;
  const FONT = '"Segoe UI", Arial, sans-serif';
  let bounds = {left:-CARD_WIDTH/2,right:CARD_WIDTH/2};
  const list = value => Array.isArray(value) ? value : [];
  const identity = value => String(typeof value === 'object' && value !== null ? value.data?.graph_id ?? value.id ?? '' : value ?? '');
  const info = node => node?.properties || node?.data || node || {};
  const sessionId = node => String(info(node).flow_session_id || '');

  function plan(rawNodes, rawEdges, {narrow=false,allSessions=false}={}) {
    const byId = new Map();
    list(rawNodes).forEach(node => { const id=identity(node); if(id) byId.set(id,node); });
    const ids = [...byId.keys()].sort();
    if (!ids.length) { bounds={left:-CARD_WIDTH/2,right:CARD_WIDTH/2}; return {positions:{},width:0,height:0}; }
    const outgoing = new Map(ids.map(id=>[id,new Set()])), incoming = new Map(ids.map(id=>[id,new Set()]));
    list(rawEdges).forEach(edge => {
      const source=identity(edge.source),target=identity(edge.target);
      if (byId.has(source) && byId.has(target)) { outgoing.get(source).add(target); incoming.get(target).add(source); }
    });
    const degrees=new Map(ids.map(id=>[id,incoming.get(id).size])), ready=ids.filter(id=>degrees.get(id)===0), order=[];
    while(ready.length) {
      const id=ready.shift(); order.push(id);
      [...outgoing.get(id)].sort().forEach(target=>{degrees.set(target,degrees.get(target)-1);if(degrees.get(target)===0){ready.push(target);ready.sort();}});
    }
    const positions={};
    if(order.length!==ids.length) {
      // Corrupt/cyclic input remains inspectable without recursive traversal.
      const columns=narrow?1:Math.min(3,Math.ceil(Math.sqrt(ids.length)));
      ids.forEach((id,index)=>{positions[id]={x:(index%columns-(columns-1)/2)*SIBLING_GAP,y:Math.floor(index/columns)*RANK_GAP};});
    } else {
      const rank=new Map();
      order.forEach(id=>rank.set(id,Math.max(0,...[...incoming.get(id)].map(parent=>rank.get(parent)+1))));
      // Align short prerequisite branches immediately above their first consumer.
      // This moves the checklist beside QA without inventing an order between them.
      [...order].reverse().forEach(id=>{
        const children=[...outgoing.get(id)];
        if(children.length) rank.set(id,Math.min(...children.map(child=>rank.get(child)))-1);
      });
      const ranked=[...order].sort((a,b)=>rank.get(a)-rank.get(b)||a.localeCompare(b));
      let groups=[ranked];
      if(allSessions) {
        const grouped=new Map();
        ranked.forEach(id=>{const key=sessionId(byId.get(id));if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(id);});
        if(grouped.size>1) {
          const groupEntries=[...grouped.entries()].sort(([ka,a],[kb,b])=>{
            const ordA=Math.min(...a.map(id=>Number(info(byId.get(id)).flow_session_ordinal)||Infinity));
            const ordB=Math.min(...b.map(id=>Number(info(byId.get(id)).flow_session_ordinal)||Infinity));
            return (ordA-ordB)||Math.min(...a.map(id=>rank.get(id)))-Math.min(...b.map(id=>rank.get(id)))||ka.localeCompare(kb);
          });
          const groupIndex=new Map(groupEntries.flatMap(([,members],index)=>members.map(id=>[id,index])));
          // If session chronology conflicts with dependency direction, retain the
          // truthful topological layout rather than reverse a saved dependency.
          const compatible=ids.every(id=>[...outgoing.get(id)].every(child=>groupIndex.get(id)<=groupIndex.get(child)));
          if(compatible)groups=groupEntries.map(([,members])=>members);
        }
      }
      let offset=0;
      groups.forEach(group=>{
        if(narrow) {
          group.forEach((id,index)=>{positions[id]={x:0,y:offset+index*RANK_GAP};});
          offset+=(group.length-1)*RANK_GAP+CARD_HEIGHT+76;
          return;
        }
        const rows=new Map(),firstRank=Math.min(...group.map(id=>rank.get(id)));
        group.forEach(id=>{const level=rank.get(id)-firstRank;if(!rows.has(level))rows.set(level,[]);rows.get(level).push(id);});
        [...rows.entries()].sort(([a],[b])=>a-b).forEach(([level,members])=>{
          members.sort((a,b)=>{
            const bary=id=>{const parents=[...incoming.get(id)].filter(p=>positions[p]);return parents.length?parents.reduce((sum,p)=>sum+positions[p].x,0)/parents.length:0;};
            return bary(a)-bary(b)||a.localeCompare(b);
          });
          members.forEach((id,index)=>{positions[id]={x:(index-(members.length-1)/2)*SIBLING_GAP,y:offset+level*RANK_GAP};});
        });
        // Keep single-card rows aligned with the branch they feed.
        [...group].reverse().forEach(id=>{
          const level=rank.get(id)-firstRank;
          if(rows.get(level).length!==1)return;
          const children=[...outgoing.get(id)].filter(child=>group.includes(child)&&positions[child]);
          if(children.length===1) positions[id].x=positions[children[0]].x;
        });
        offset+=Math.max(...[...rows.keys()])*RANK_GAP+CARD_HEIGHT+76;
      });
    }
    const values=Object.values(positions),minX=Math.min(...values.map(p=>p.x)),maxX=Math.max(...values.map(p=>p.x));
    const minY=Math.min(...values.map(p=>p.y)),maxY=Math.max(...values.map(p=>p.y));
    const centerX=(minX+maxX)/2;
    values.forEach(p=>{p.x-=centerX;});
    bounds={left:minX-centerX-CARD_WIDTH/2,right:maxX-centerX+CARD_WIDTH/2};
    const hasRoutedEdge=ids.some(id=>[...outgoing.get(id)].some(child=>{
      const dy=positions[child].y-positions[id].y;return dy<=CARD_HEIGHT+15||dy>=RANK_GAP*1.35;
    }));
    return {positions,width:maxX-minX+CARD_WIDTH+(hasRoutedEdge?64:0),height:maxY-minY+CARD_HEIGHT};
  }

  function roundedRect(ctx,x,y,width,height,radius=10) {
    ctx.beginPath();ctx.moveTo(x+radius,y);ctx.lineTo(x+width-radius,y);ctx.quadraticCurveTo(x+width,y,x+width,y+radius);
    ctx.lineTo(x+width,y+height-radius);ctx.quadraticCurveTo(x+width,y+height,x+width-radius,y+height);
    ctx.lineTo(x+radius,y+height);ctx.quadraticCurveTo(x,y+height,x,y+height-radius);
    ctx.lineTo(x,y+radius);ctx.quadraticCurveTo(x,y,x+radius,y);ctx.closePath();
  }

  function shorten(ctx,value,width) {
    const text=String(value??'');if(ctx.measureText(text).width<=width)return text;
    let result=text;while(result.length&&ctx.measureText(result+'…').width>width)result=result.slice(0,-1);
    return result+'…';
  }

  function titleLines(ctx,value,width) {
    const words=String(value||'Untitled task').trim().split(/\s+/), lines=[];
    let line='';
    for(let index=0;index<words.length;index++) {
      const next=line?line+' '+words[index]:words[index];
      if(ctx.measureText(next).width<=width){line=next;continue;}
      if(!line){lines.push(shorten(ctx,words[index],width));line='';}
      else {lines.push(line);line=words[index];}
      if(lines.length===1){line=[line,...words.slice(index+1)].filter(Boolean).join(' ');break;}
    }
    if(line)lines.push(shorten(ctx,line,width));
    return lines.slice(0,2);
  }

  function drawNode(node,ctx,selected=Boolean(node?.data?.selected)) {
    if(!Number.isFinite(node?.x)||!Number.isFinite(node?.y))return;
    const data=node.data||{},left=node.x-CARD_WIDTH/2,top=node.y-CARD_HEIGHT/2;
    const statusColor=data.statusColor||node.borderColor||'#6c8778';
    ctx.save();ctx.shadowColor='rgba(23,52,41,0.08)';ctx.shadowBlur=selected?10:5;ctx.shadowOffsetY=2;
    roundedRect(ctx,left,top,CARD_WIDTH,CARD_HEIGHT);
    ctx.fillStyle=node.color||'#ffffff';ctx.fill();ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    ctx.lineWidth=selected?2.5:1;ctx.strokeStyle=selected?'#245f4c':(node.borderColor||'#cfddd3');ctx.stroke();
    if(selected){ctx.fillStyle='#245f4c';roundedRect(ctx,left+1,top+12,4,CARD_HEIGHT-24,2);ctx.fill();}
    ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle='#17382b';ctx.font='600 14px '+FONT;
    const lines=titleLines(ctx,data.title||node.title,CARD_WIDTH-28);
    lines.forEach((line,index)=>ctx.fillText(line,left+14,top+22+index*17));
    ctx.font='500 12px '+FONT;ctx.fillStyle='#405d4d';
    ctx.fillText(shorten(ctx,data.agent||'Agent not assigned',CARD_WIDTH-28),left+14,top+62);
    ctx.font='400 11px '+FONT;ctx.fillStyle='#718277';
    ctx.fillText(shorten(ctx,data.sessionLabel||'No session recorded',CARD_WIDTH-28),left+14,top+80);
    ctx.fillStyle=statusColor;ctx.beginPath();ctx.arc(left+18,top+98,3,0,Math.PI*2);ctx.fill();
    ctx.font='600 11px '+FONT;ctx.fillStyle='#405d4d';
    ctx.fillText(shorten(ctx,data.statusLabel||'Status not recorded',CARD_WIDTH-40),left+27,top+102);
    ctx.restore();
  }

  function paintNodeArea(node,color,ctx) {
    if(!Number.isFinite(node?.x)||!Number.isFinite(node?.y))return;
    ctx.save();ctx.fillStyle=color;roundedRect(ctx,node.x-CARD_WIDTH/2,node.y-CARD_HEIGHT/2,CARD_WIDTH,CARD_HEIGHT);ctx.fill();ctx.restore();
  }

  function route(link,ctx) {
    const source=link.source,target=link.target;
    if(!Number.isFinite(source?.x)||!Number.isFinite(source?.y)||!Number.isFinite(target?.x)||!Number.isFinite(target?.y))return null;
    const dx=target.x-source.x,dy=target.y-source.y;
    ctx.beginPath();
    if(dy>CARD_HEIGHT+15&&dy<RANK_GAP*1.35) {
      const start={x:source.x,y:source.y+CARD_HEIGHT/2+2},end={x:target.x,y:target.y-CARD_HEIGHT/2-4};
      ctx.moveTo(start.x,start.y);
      const mid=(start.y+end.y)/2;
      ctx.bezierCurveTo(start.x,mid,end.x,mid,end.x,end.y);
      return {x:end.x,y:end.y,angle:Math.PI/2};
    }
    const side=dx<0?-1:1;
    const rail=side>0?Math.max(bounds.right,source.x+CARD_WIDTH/2,target.x+CARD_WIDTH/2)+28:
      Math.min(bounds.left,source.x-CARD_WIDTH/2,target.x-CARD_WIDTH/2)-28;
    const same=source===target||identity(source)===identity(target);
    const start={x:source.x+side*(CARD_WIDTH/2+2),y:source.y-(same?20:0)};
    const end={x:target.x+side*(CARD_WIDTH/2+4),y:target.y+(same?20:0)};
    ctx.moveTo(start.x,start.y);ctx.lineTo(rail,start.y);ctx.lineTo(rail,end.y);ctx.lineTo(end.x,end.y);
    return {x:end.x,y:end.y,angle:side>0?Math.PI:0};
  }

  function drawLink(link,ctx,scale=1) {
    ctx.save();const end=route(link,ctx);if(!end){ctx.restore();return;}
    const color=link.color||'#91a99b';ctx.strokeStyle=color;ctx.lineWidth=1.7;
    ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash(link.data?.historical?[5,4]:[]);ctx.stroke();ctx.setLineDash([]);
    ctx.translate(end.x,end.y);ctx.rotate(end.angle);ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-8,-4.5);ctx.lineTo(-8,4.5);ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.restore();
  }

  function paintLinkArea(link,color,ctx) {
    ctx.save();if(route(link,ctx)){ctx.strokeStyle=color;ctx.lineWidth=10;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();}ctx.restore();
  }

  function createRenderer(isSelectedFn=()=>false) {
    return {node:{nodeCanvasObject:(node,ctx)=>drawNode(node,ctx,Boolean(isSelectedFn(node)||node.data?.selected)),nodePointerAreaPaint:paintNodeArea},
      link:{linkCanvasObject:drawLink,linkPointerAreaPaint:paintLinkArea}};
  }
  const api={plan,drawNode,paintNodeArea,drawLink,paintLinkArea,createRenderer,CARD_WIDTH,CARD_HEIGHT,RANK_GAP,SIBLING_GAP,width:CARD_WIDTH,height:CARD_HEIGHT};
  root.RelayWorkflowCanvas=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
