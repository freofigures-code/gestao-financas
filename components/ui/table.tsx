import * as React from "react"; import {cn} from "@/lib/utils";
export const Table=({className,...p}:React.TableHTMLAttributes<HTMLTableElement>)=><div className="w-full overflow-auto"><table className={cn("w-full text-sm",className)} {...p}/></div>;
export const THead=(p:React.HTMLAttributes<HTMLTableSectionElement>)=><thead className="border-b" {...p}/>; export const TBody=(p:React.HTMLAttributes<HTMLTableSectionElement>)=><tbody {...p}/>;
export const TR=({className,...p}:React.HTMLAttributes<HTMLTableRowElement>)=><tr className={cn("border-b hover:bg-muted/40",className)} {...p}/>;
export const TH=({className,...p}:React.ThHTMLAttributes<HTMLTableCellElement>)=><th className={cn("h-11 px-3 text-left align-middle font-medium text-muted-foreground whitespace-nowrap",className)} {...p}/>;
export const TD=({className,...p}:React.TdHTMLAttributes<HTMLTableCellElement>)=><td className={cn("p-3 align-middle",className)} {...p}/>;
