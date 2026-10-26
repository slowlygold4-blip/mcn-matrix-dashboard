"use client";
import {type ComponentProps} from 'react';
import {Table as BaseTable} from '@/components/ui/table';
import {TableScrollFrame} from '@/components/table-scroll-frame';
export function ScrollableTable({className,scrollLabel='完整数据表，左右方向键横向滚动',staticLabel, bounded=false,scrollResetKey,...props}:ComponentProps<typeof BaseTable>&{scrollLabel?:string,staticLabel?:string,bounded?:boolean,scrollResetKey?:string}){
 return <TableScrollFrame scrollLabel={scrollLabel} staticLabel={staticLabel} bounded={bounded} scrollResetKey={scrollResetKey}><BaseTable className={['data-table',className].filter(Boolean).join(' ')} {...props}/></TableScrollFrame>;
}
