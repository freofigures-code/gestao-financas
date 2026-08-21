"use client";
import {createContext,useContext,useEffect,useMemo,useState} from "react"; import {currentMonthKey,isFutureMonth} from "@/lib/date";
type Ctx={month:string;setMonth:(m:string)=>void}; const MonthContext=createContext<Ctx|null>(null);
export function MonthProvider({children}:{children:React.ReactNode}){ const [month,setRaw]=useState(currentMonthKey()); useEffect(()=>{const s=localStorage.getItem("freo_month"); if(s&&!isFutureMonth(s)) setRaw(s)},[]); const setMonth=(m:string)=>{if(isFutureMonth(m)) return; setRaw(m); localStorage.setItem("freo_month",m)}; const value=useMemo(()=>({month,setMonth}),[month]); return <MonthContext.Provider value={value}>{children}</MonthContext.Provider> }
export function useMonth(){const c=useContext(MonthContext); if(!c) throw new Error("useMonth fora do provider"); return c;}
