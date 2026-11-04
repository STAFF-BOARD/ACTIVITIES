"use client";

import { useEffect, useRef, useState } from "react";
import { autocorregir } from "@/lib/ortografia";
import { Modal } from "@/components/ui/modal";
import { TaskFormModal } from "./task-form-modal";
import { useApp } from "@/lib/store";
import { EventTask, TaskExecStatus } from "@/lib/types";
import { colorTokens, formatFullDate, timeAgo } from "@/lib/utils";
import { cancelRemainingSeconds, canStillCancel, isTaskFull, slotProgress } from "@/lib/task-helpers";
import { Avatar } from "@/components/ui/avatar";
import { ProgressBar } from "@/components/ui/progress";
import { ExecStatusPill, PriorityPill } from "@/components/ui/pills";
import { Paperclip, ImagePlus, Send, Crown, UserPlus, UserMinus, X, FileText, Hourglass, AlertTriangle, Lock, Users, RotateCcw, CheckCircle2, Pencil, AtSign, Trash2 } from "lucide-react";
import { cx } from "@/lib/utils";

const statusOrder: TaskExecStatus[] = ["sin_iniciar", "en_proceso", "terminada"];
const statusLabel: Record<TaskExecStatus, string> = {
  sin_iniciar: "Sin iniciar",
  en_proceso: "En proceso",
  terminada: "Terminada",
};

export function TaskDetailModal({ open, onClose, task }: { open: boolean; onClose: () => void; task: EventTask }) {
  const { userById, eventById, currentUser, isAdmin, claimSlot, cancelSlot, confirmSlot, quitarInscripcion, joinWaitlist, leaveWaitlist, hasEvidence, canFinishTask, setExecStatus, addChatMessage, refreshTaskChat, toggleReaction, deleteChatMessage, addEvidence, removeEvidence, deleteTask, settings } =
    useApp();
  const [tab, setTab] = useState<"detalle" | "chat" | "evidencias">("detalle");
  const [message, setMessage] = useState("");
  const [subiendo, setSubiendo] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [aviso, setAviso] = useState("");
  const [adjuntos, setAdjuntos] = useState<File[]>([]);
  const [privadoPara, setPrivadoPara] = useState<string | null>(null);
  const [listaMenciones, setListaMenciones] = useState(false);
  const fotoRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const chatFotoRef = useRef<HTMLInputElement>(null);
  const chatDocRef = useRef<HTMLInputElement>(null);

  /** Sube uno o varios archivos como evidencia de la tarea. */
  async function subirEvidencias(lista: File[]) {
    if (!lista || lista.length === 0) return;
    setSubiendo(true);
    setAviso("");
    for (let i = 0; i < lista.length; i++) {
      const f = lista[i];
      setProgreso(`Subiendo ${i + 1} de ${lista.length}: ${f.name}`);
      const err = await addEvidence(task.id, f);
      if (err) {
        setAviso(lista.length > 1 ? `«${f.name}»: ${err}` : err);
        break;
      }
    }
    setProgreso("");
    setSubiendo(false);
  }
  const [, forceTick] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const event = eventById(task.eventId);
  const tokens = colorTokens[task.color];
  const { filled, total, pct } = slotProgress(task);
  const full = isTaskFull(task);
  const mySlot = task.slots.find((s) => s.userId === currentUser?.id);
  const eventoCerrado = event?.status === "finalizado" || event?.status === "archivado";
  /* ------------------------------------------------------------------
     QUIÉN PUEDE HACER QUÉ EN UNA TAREA
       Cualquiera         : ver la tarea, quiénes participan, e inscribirse.
       Equipo confirmado  : chat, evidencias y avance de la tarea.
       Líder              : lo anterior + moderar las evidencias.
       Creador del evento : lo anterior + editar y eliminar la tarea.
       Administrador      : todo, por su papel de supervisión.
     ------------------------------------------------------------------ */
  const esDuenoEvento = event?.createdBy === currentUser?.id;
  /** Editar o eliminar la tarea: solo quien creó el evento (y la administración). */
  const canManage = (isAdmin || esDuenoEvento) && !eventoCerrado;
  const inWaitlist = task.waitlist.includes(currentUser?.id ?? "");
  const waitPos = task.waitlist.indexOf(currentUser?.id ?? "") + 1;
  const evidenceOk = canFinishTask(task);
  const mySecsLeft = cancelRemainingSeconds(mySlot?.claimedAt ?? null, settings.cancelWindowMinutes);
  // El chat es del EQUIPO de la tarea: inscritos, líder y dueño del evento.
  const team = [
    ...task.slots.map((sl) => sl.userId),
    task.leaderId,
    event?.createdBy,
  ].filter((x): x is string => !!x);
  /* Una inscripción cuenta como definitiva cuando ya pasó el tiempo para
     deshacerla. Antes de eso no se entra al chat, porque todavía puede irse. */
  const inscripcionConfirmada =
    !!mySlot && (!mySlot.claimedAt || cancelRemainingSeconds(mySlot.claimedAt, settings.cancelWindowMinutes) === 0);
  const esResponsable = isAdmin || task.leaderId === currentUser?.id || event?.createdBy === currentUser?.id;
  const canWrite = esResponsable || inscripcionConfirmada;
  /** Con quién se puede hablar en privado dentro de esta tarea. */
  const companeros = Array.from(new Set(team)).filter((id) => id !== currentUser?.id);
  /** El avance lo marca quien trabaja en la tarea, no solo la administración. */
  const esLider = task.leaderId === currentUser?.id;
  /** Marcar el avance: lo hace quien trabaja en la tarea. */
  const puedeCambiarEstado = (canWrite || canManage) && !eventoCerrado;
  /** Subir evidencias: solo el equipo confirmado, no cualquiera que mire. */
  const puedeSubirEvidencia = canWrite && !eventoCerrado;
  /** Moderar cualquier evidencia: líder, dueño del evento o administración. */
  const puedeModerarEvidencia = isAdmin || esDuenoEvento || esLider;

  useEffect(() => {
    const id = setInterval(() => forceTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (tab === "chat") chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [tab, task.chat.length]);

  // Al abrir la tarea traemos la conversación fresca. Hace falta sobre todo
  // después de inscribirse: antes no se tenía permiso para leerla.
  useEffect(() => {
    if (open && canWrite) refreshTaskChat(task.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canWrite, task.id, task.slots.map((sl) => sl.userId).join(",")]);

  /** Ejecuta una acción y, si el servidor la rechaza, muestra por qué. */
  async function ejecutar(accion: () => Promise<string | void>) {
    setAviso("");
    setSubiendo(true);
    const err = await accion();
    setSubiendo(false);
    if (err) setAviso(err);
  }

  function handleJoin(idx: number) {
    ejecutar(() => claimSlot(task.id, idx));
  }

  /** Administración: quitar su propia inscripción o la de alguien que no sea administrador. */
  function handleQuitar(userId: string) {
    const propia = userId === currentUser?.id;
    const nombre = userById(userId)?.name ?? "esta persona";
    const pregunta = propia
      ? `¿Cancelar tu inscripción en "${task.name}"?`
      : `¿Quitar a ${nombre} de "${task.name}"? Se le avisará y su lugar quedará libre.`;
    if (!window.confirm(pregunta)) return;
    ejecutar(() => quitarInscripcion(task.id, userId));
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    if (!message.trim() && adjuntos.length === 0) return;
    setSubiendo(true);
    setAviso("");
    setProgreso(adjuntos.length > 0 ? `Preparando ${adjuntos.length} archivo${adjuntos.length > 1 ? "s" : ""}...` : "");

    const err = await addChatMessage(
      task.id,
      message.trim(),
      adjuntos,
      privadoPara,
      (hecho, total, nombre) => {
        if (total === 0) return;
        setProgreso(hecho >= total ? "Enviando el mensaje..." : `Subiendo ${hecho + 1} de ${total}: ${nombre}`);
      }
    );

    setSubiendo(false);
    setProgreso("");
    if (err) {
      // No borramos ni el texto ni los adjuntos: así puede reintentar sin
      // volver a escribirlo todo ni a buscar las fotos otra vez.
      setAviso(err);
      return;
    }
    setMessage("");
    setAdjuntos([]);
    setPrivadoPara(null);
  }

  return (
    <Modal open={open} onClose={onClose} eyebrow={event?.name ?? "Tarea"} title={task.name} size="lg">
      {aviso && (
        <div className="-mt-2 mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{aviso}</span>
          <button onClick={() => setAviso("")} aria-label="Cerrar aviso" className="text-rose-500 hover:text-rose-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2">
        <ExecStatusPill status={task.status} />
        <PriorityPill priority={task.priority} />
        <span className="text-xs text-ink-400">Vence el {formatFullDate(task.dueDate)}</span>
      </div>

      {mySecsLeft > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-amber-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Quedaste inscrito. Si te equivocaste, puedes deshacerlo durante{" "}
              <b className="rounded bg-amber-100 px-1.5 font-bold tabular-nums">
                {`${Math.floor(mySecsLeft / 60)}:${String(mySecsLeft % 60).padStart(2, "0")}`}
              </b>
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => ejecutar(() => cancelSlot(task.id))}
              className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Deshacer
            </button>
            <button
              onClick={() => ejecutar(() => confirmSlot(task.id))}
              title="Renunciar al tiempo de espera y entrar al chat ahora"
              className="flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-800"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Ya me decidí, confirmar
            </button>
          </div>
        </div>
      )}

      <div className="mb-5 flex gap-1 rounded-xl bg-ink-50 p-1">
        {(["detalle", "chat", "evidencias"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              "flex-1 rounded-lg py-2 text-sm font-medium capitalize transition-colors",
              tab === t ? "bg-white text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-800"
            )}
          >
            {t === "detalle" ? "Detalle" : t === "chat" ? `Chat (${task.chat.length})` : `Evidencias (${task.evidence.length + task.attachments.length})`}
          </button>
        ))}
      </div>

      {tab === "detalle" && (
        <div className="space-y-6">
          <p className="text-sm leading-relaxed text-ink-600">{task.description || "Sin descripción adicional."}</p>

          {task.referenceImage && (
            <div>
              <p className="mb-2 text-sm font-medium text-ink-700">Imagen de referencia</p>
              <a href={task.referenceImage} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={task.referenceImage}
                  alt="Referencia de cómo debe quedar el trabajo"
                  className="max-h-56 w-full rounded-xl border border-ink-100 object-cover"
                />
              </a>
              <p className="mt-1.5 text-xs text-ink-400">Así debe quedar el trabajo. Toca la imagen para verla completa.</p>
            </div>
          )}

          {task.requiresLeader && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <Crown className="h-4 w-4" />
              {task.leaderId ? (
                <span>
                  Líder asignado: <strong>{userById(task.leaderId)?.name}</strong>
                </span>
              ) : (
                <span>Esta tarea requiere un líder (sin asignar aún).</span>
              )}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-ink-700">Colaboradores</span>
              <span className="text-ink-500">{filled} de {total} lugares ocupados</span>
            </div>
            <ProgressBar value={pct} colorClass={full ? "bg-ink-400" : tokens.solid} className="mb-4" />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {task.slots.map((slot, idx) => {
                const user = slot.userId ? userById(slot.userId) : null;
                const isMe = slot.userId === currentUser?.id;
                const remaining = isMe ? cancelRemainingSeconds(slot.claimedAt, settings.cancelWindowMinutes) : 0;
                // Un administrador puede salir cuando quiera y quitar a quien no sea administrador.
                const puedeQuitar = !!user && isAdmin && !eventoCerrado && (isMe || user.role !== "admin");
                return (
                  <div
                    key={idx}
                    className={cx(
                      "flex items-center justify-between rounded-xl border px-3 py-2.5",
                      user ? "border-ink-100 bg-ink-50/60" : "border-dashed border-ink-200"
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="w-5 text-xs font-semibold text-ink-400">#{idx + 1}</span>
                      {user ? (
                        <>
                          <Avatar name={user.name} color={user.color} size="xs" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink-800">
                              {user.name}
                              {task.leaderId === user.id && (
                                <Crown className="ml-1 inline h-3 w-3 text-amber-600" />
                              )}
                            </span>
                            {(user.title || user.area) && (
                              <span className="block truncate text-[11px] text-ink-400">
                                {user.title}
                                {user.title && user.area ? " · " : ""}
                                {user.area}
                              </span>
                            )}
                          </span>
                        </>
                      ) : (
                        <span className="text-sm text-ink-400">Lugar disponible</span>
                      )}
                    </div>
                    {user ? (
                      isMe && canStillCancel(slot.claimedAt, settings.cancelWindowMinutes) ? (
                        <button
                          onClick={() => ejecutar(() => cancelSlot(task.id))}
                          className="flex items-center gap-1 text-xs font-medium text-amber-700 hover:underline"
                        >
                          <RotateCcw className="h-3 w-3" /> Deshacer ·{" "}
                          <b className="tabular-nums">
                            {`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
                          </b>
                        </button>
                      ) : isMe || puedeQuitar ? (
                        <div className="flex shrink-0 items-center gap-2">
                          {isMe && <span className="badge bg-brand-100 text-brand-800">Confirmado</span>}
                          {puedeQuitar && (
                            <button
                              onClick={() => handleQuitar(user.id)}
                              disabled={subiendo}
                              title={isMe ? "Cancelar mi inscripción" : `Quitar a ${user.name} de la tarea`}
                              aria-label={isMe ? "Cancelar mi inscripción" : `Quitar a ${user.name} de la tarea`}
                              className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                            >
                              <UserMinus className="h-3.5 w-3.5" /> {isMe ? "Salir" : "Quitar"}
                            </button>
                          )}
                        </div>
                      ) : null
                    ) : (
                      !mySlot && (
                        <button
                          onClick={() => handleJoin(idx)}
                          className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                        >
                          <UserPlus className="h-3 w-3" /> Ocupar
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {(full || task.waitlist.length > 0) && (
            <div className="border-t border-ink-100 pt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink-700">
                  <Hourglass className="h-4 w-4" /> Lista de espera
                </p>
                <span className="badge bg-ink-100 text-ink-600">
                  {task.waitlist.length} {task.waitlist.length === 1 ? "persona" : "personas"}
                </span>
              </div>
              {task.waitlist.length === 0 ? (
                <p className="text-sm text-ink-400">Nadie espera turno todavía.</p>
              ) : (
                <div className="space-y-2">
                  {task.waitlist.map((uid, idx) => {
                    const wu = userById(uid);
                    const isMe = uid === currentUser?.id;
                    return (
                      <div key={uid} className="flex items-center justify-between rounded-xl border border-dashed border-ink-200 px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className="w-5 text-xs font-semibold text-ink-400">{idx + 1}º</span>
                          <Avatar name={wu?.name ?? "?"} color={wu?.color} size="xs" />
                          <span className="text-sm font-medium text-ink-800">{wu?.name}</span>
                          {isMe && <span className="badge bg-amber-100 text-amber-800">Tú</span>}
                        </div>
                        {isMe && (
                          <button onClick={() => ejecutar(() => leaveWaitlist(task.id))} className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:underline">
                            <X className="h-3 w-3" /> Salir
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!mySlot && !inWaitlist && full && (
                <button onClick={() => ejecutar(() => joinWaitlist(task.id))} className="btn-secondary mt-3 w-full">
                  <Hourglass className="h-4 w-4" /> Apuntarme a la lista de espera
                </button>
              )}
              {inWaitlist && (
                <p className="mt-2 text-xs text-ink-500">
                  Eres el <strong>{waitPos}º</strong> en la fila. Si alguien cancela, entras automáticamente y te avisamos.
                </p>
              )}
            </div>
          )}

          {puedeCambiarEstado && (
            <div>
              <p className="label">Estado de ejecución</p>
              <div className="flex gap-2">
                {statusOrder.map((s) => {
                  const blocked = s === "terminada" && !evidenceOk;
                  return (
                    <button
                      key={s}
                      onClick={() => {
                        if (blocked) {
                          setAviso("Para cerrar la tarea primero sube una evidencia del trabajo (una foto o un documento).");
                          setTab("evidencias");
                          return;
                        }
                        ejecutar(() => setExecStatus(task.id, s));
                      }}
                      title={blocked ? "Sube una evidencia para poder cerrar la tarea" : undefined}
                      className={cx(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                        task.status === s ? "border-brand-600 bg-brand-50 text-brand-800" : "border-ink-200 text-ink-500 hover:bg-ink-50",
                        blocked && "opacity-60"
                      )}
                    >
                      {blocked && <Lock className="h-3.5 w-3.5" />}
                      {statusLabel[s]}
                    </button>
                  );
                })}
              </div>
              {!evidenceOk && (
                <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Esta tarea necesita al menos una evidencia antes de darse por terminada.{" "}
                    <button onClick={() => setTab("evidencias")} className="font-semibold underline">
                      Subir evidencia
                    </button>
                  </span>
                </div>
              )}
            </div>
          )}

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-ink-100 pt-4">
              <span className="mr-auto text-xs text-ink-400">
                {isAdmin && !esDuenoEvento ? "Acciones de administración" : "Acciones del organizador del evento"}
              </span>
              <button onClick={() => setEditOpen(true)} className="btn-secondary !py-1.5 !text-xs">
                <Pencil className="h-3.5 w-3.5" /> Editar tarea
              </button>
              <button
                onClick={() => {
                  if (!window.confirm(`¿Eliminar la tarea "${task.name}"? Se borrarán su chat y sus evidencias.`)) return;
                  deleteTask(task.id);
                  onClose();
                }}
                className="text-sm font-medium text-rose-600 hover:underline"
              >
                Eliminar tarea
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "chat" && (
        <div className="flex h-[420px] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto pr-1">
            {task.chat.length === 0 && (
              <p className="py-10 text-center text-sm text-ink-400">
                {canWrite
                  ? "Aún no hay mensajes. Sé el primero en escribir."
                  : "La conversación es privada del equipo de esta tarea. Inscríbete para verla."}
              </p>
            )}
            {task.chat.map((m) => {
              const author = userById(m.authorId);
              const nombreAutor = author?.name ?? "Usuario eliminado";
              const mine = m.authorId === currentUser?.id;
              return (
                <div key={m.id} className={cx("flex gap-2.5", mine && "flex-row-reverse")}>
                  <Avatar name={nombreAutor} color={author?.color} size="sm" />
                  <div className={cx("max-w-[75%]", mine && "items-end text-right")}>
                    <div
                      className={cx(
                        "rounded-2xl px-3.5 py-2.5 text-sm",
                        m.recipientId
                          ? mine
                            ? "border border-violet-300 bg-violet-700 text-white"
                            : "border border-violet-300 bg-violet-50 text-violet-900"
                          : mine
                          ? "bg-brand-700 text-white"
                          : "bg-ink-100 text-ink-800"
                      )}
                    >
                      {m.recipientId && (
                        <p className={cx("mb-1 flex items-center gap-1 text-[11px] font-semibold", mine ? "text-violet-100" : "text-violet-700")}>
                          <Lock className="h-3 w-3" />
                          {mine
                            ? `Privado para ${userById(m.recipientId)?.name ?? "…"}`
                            : "Privado, solo para ti"}
                        </p>
                      )}
                      {!mine && <p className="mb-0.5 text-xs font-semibold text-brand-700">{nombreAutor}</p>}
                      {m.text}

                      {(m.attachments ?? []).length > 0 && (
                        <div className={cx("space-y-2", m.text && "mt-2")}>
                          {(m.attachments ?? []).map((a) =>
                            a.type === "image" && a.url ? (
                              <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="block">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={a.url}
                                  alt={a.name}
                                  className="max-h-52 w-full rounded-xl border border-black/10 object-cover"
                                />
                              </a>
                            ) : (
                              <a
                                key={a.id}
                                href={a.url ?? "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cx(
                                  "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs",
                                  mine ? "bg-white/15 hover:bg-white/25" : "bg-white hover:bg-ink-50"
                                )}
                              >
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{a.name}</span>
                              </a>
                            )
                          )}
                        </div>
                      )}
                    </div>
                    <div className={cx("mt-1 flex items-center gap-2 text-[11px] text-ink-400", mine && "justify-end")}>
                      <span>{timeAgo(m.createdAt)}</span>
                      {(mine || isAdmin) && (
                        <button
                          onClick={async () => {
                            if (!window.confirm("¿Eliminar este mensaje? No se puede deshacer.")) return;
                            const err = await deleteChatMessage(task.id, m.id);
                            if (err) setAviso(err);
                          }}
                          title="Eliminar mensaje"
                          aria-label="Eliminar mensaje"
                          className="text-ink-300 transition-colors hover:text-rose-600"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                      {(["👍", "❤️", "✅"] as const).map((emoji) => {
                        const count = m.reactions[emoji]?.length ?? 0;
                        return (
                          <button
                            key={emoji}
                            onClick={() => toggleReaction(task.id, m.id, emoji)}
                            className={cx(
                              "rounded-full border px-1.5 py-0.5",
                              count > 0 ? "border-brand-200 bg-brand-50 text-brand-700" : "border-ink-200 text-ink-400 hover:bg-ink-50"
                            )}
                          >
                            {emoji} {count > 0 && count}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>
          {!canWrite ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm leading-relaxed text-amber-800">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {mySlot ? (
                  <>
                    <strong>Chat bloqueado por ahora.</strong> Tu inscripción aún se puede deshacer. Cuando termine
                    el tiempo de espera entrarás automáticamente al chat del equipo.
                  </>
                ) : (
                  <>
                    <strong>Chat privado del equipo.</strong> Puedes ver la tarea y quiénes participan, pero la
                    conversación es solo para quienes trabajan en ella. Inscríbete para entrar.
                  </>
                )}
              </span>
            </div>
          ) : (
          <div className="mt-3 border-t border-ink-100 pt-3">
            {progreso && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3.5 py-2.5">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-300 border-t-brand-700" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-brand-800">{progreso}</span>
              </div>
            )}
            {adjuntos.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {adjuntos.map((f, i) => (
                  <span
                    key={`${f.name}-${i}`}
                    className="flex max-w-[220px] items-center gap-1.5 rounded-lg bg-ink-100 px-2 py-1 text-xs text-ink-700"
                  >
                    {f.type.startsWith("image/") ? <ImagePlus className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => setAdjuntos((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Quitar ${f.name}`}
                      className="text-ink-400 hover:text-rose-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {privadoPara && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs text-violet-800">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">
                  Mensaje privado para <strong>{userById(privadoPara)?.name ?? "…"}</strong>. Nadie más lo verá.
                </span>
                <button type="button" onClick={() => setPrivadoPara(null)} aria-label="Quitar destinatario privado">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {listaMenciones && companeros.length > 0 && (
              <div className="mb-2 rounded-xl border border-ink-200 bg-white p-1.5 shadow-sm">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                  Escribir en privado a
                </p>
                {companeros.map((id) => {
                  const persona = userById(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setPrivadoPara(id);
                        setListaMenciones(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-50"
                    >
                      <Avatar name={persona?.name ?? "?"} color={persona?.color} size="xs" />
                      <span className="truncate">{persona?.name ?? "Alguien"}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2">
              {/* OJO: hay que copiar los archivos a una variable ANTES de vaciar
                  el campo. Si se hace al revés, React ejecuta la actualización
                  un instante después, cuando la lista ya está vacía, y el
                  archivo elegido se pierde sin dar ningún error. */}
              <input
                ref={chatFotoRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const elegidos = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (elegidos.length > 0) setAdjuntos((prev) => [...prev, ...elegidos]);
                }}
              />
              <input
                ref={chatDocRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const elegidos = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (elegidos.length > 0) setAdjuntos((prev) => [...prev, ...elegidos]);
                }}
              />
              {companeros.length > 0 && (
                <button
                  type="button"
                  onClick={() => setListaMenciones((v) => !v)}
                  className="btn-ghost !px-2.5"
                  title="Escribir en privado a alguien del equipo"
                >
                  <AtSign className="h-4 w-4" />
                </button>
              )}
              <button type="button" onClick={() => chatFotoRef.current?.click()} className="btn-ghost !px-2.5" title="Compartir fotografía">
                <ImagePlus className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => chatDocRef.current?.click()} className="btn-ghost !px-2.5" title="Compartir documento">
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                className="input flex-1"
                placeholder={subiendo ? "Enviando..." : "Escribe un mensaje..."}
                disabled={subiendo}
                value={message}
                onChange={(e) => setMessage(autocorregir(e.target.value))}
              />
              <button type="submit" disabled={subiendo} className="btn-primary !px-3.5">
                {subiendo ? <Hourglass className="h-4 w-4 animate-pulse" /> : <Send className="h-4 w-4" />}
              </button>
            </form>
            {aviso && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{aviso}</span>
                <button onClick={() => setAviso("")} aria-label="Cerrar aviso">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
          )}
          {canWrite && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
              <Users className="h-3.5 w-3.5" /> Este chat lo ven las {new Set(team).size} personas del equipo de la
              tarea, no todo el colegio.
            </p>
          )}
        </div>
      )}

      {tab === "evidencias" && (
        <div className="space-y-6">
          {settings.requireEvidence && (
            <div
              className={cx(
                "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed",
                hasEvidence(task) ? "border-brand-200 bg-brand-50 text-brand-800" : "border-ink-200 bg-ink-50 text-ink-600"
              )}
            >
              {hasEvidence(task) ? <ImagePlus className="mt-0.5 h-4 w-4 shrink-0" /> : <ImagePlus className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>
                {hasEvidence(task)
                  ? "Esta tarea ya tiene evidencia registrada, puede darse por terminada."
                  : "Cuando termines el trabajo, sube aquí una foto o un documento. Solo hará falta al momento de marcarla como Terminada."}
              </span>
            </div>
          )}
          {aviso && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{aviso}</p>
          )}

          {progreso && (
            <div className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3.5 py-2.5">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-300 border-t-brand-700" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-brand-800">{progreso}</span>
            </div>
          )}

          <input
            ref={fotoRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const elegidos = Array.from(e.target.files ?? []);
              e.target.value = "";
              subirEvidencias(elegidos);
            }}
          />
          <input
            ref={docRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const elegidos = Array.from(e.target.files ?? []);
              e.target.value = "";
              subirEvidencias(elegidos);
            }}
          />

          {!puedeSubirEvidencia && (
            <div className="flex items-start gap-2.5 rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-3 text-sm leading-relaxed text-ink-600">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
              <span>
                Puedes ver el trabajo documentado, pero solo quienes están inscritos en la tarea pueden
                subir o quitar evidencias.
              </span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink-700">Fotografías de avance</p>
            {puedeSubirEvidencia && (
              <button
                onClick={() => fotoRef.current?.click()}
                disabled={subiendo}
                className="btn-secondary !py-1.5 !text-xs"
              >
                <ImagePlus className="h-3.5 w-3.5" /> {subiendo ? "Subiendo..." : "Subir foto"}
              </button>
            )}
          </div>
          {task.evidence.length === 0 ? (
            <p className="text-sm text-ink-400">No se han subido evidencias aún.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {task.evidence.map((ev) => {
                const autor = userById(ev.uploadedBy);
                const puedeBorrar = puedeModerarEvidencia || ev.uploadedBy === currentUser?.id;
                return (
                  <div key={ev.id} className="group relative overflow-hidden rounded-xl border border-ink-100">
                    {ev.url ? (
                      <a href={ev.url} target="_blank" rel="noopener noreferrer" title={`${ev.name} · ${autor?.name ?? ""}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={ev.url} alt={ev.name} className="aspect-square w-full object-cover" />
                      </a>
                    ) : (
                      <div className="flex aspect-square flex-col items-center justify-center bg-gradient-to-br from-brand-100 to-brand-50 p-3 text-center">
                        <ImagePlus className="mb-1 h-5 w-5 text-brand-600" />
                        <p className="truncate text-[11px] font-medium text-ink-700">{ev.name}</p>
                      </div>
                    )}
                    <div className="bg-white px-2 py-1.5">
                      <p className="truncate text-[11px] font-medium text-ink-700">{ev.name}</p>
                      <p className="truncate text-[10px] text-ink-400">
                        {autor?.name ?? "—"} · {timeAgo(ev.uploadedAt)}
                      </p>
                    </div>
                    {puedeBorrar && (
                      <button
                        onClick={async () => {
                          const err = await removeEvidence(task.id, ev.id);
                          if (err) setAviso(err);
                        }}
                        aria-label={`Eliminar ${ev.name}`}
                        className="absolute right-1.5 top-1.5 rounded-lg bg-white/90 p-1 text-rose-600 opacity-0 shadow transition-opacity group-hover:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-ink-100 pt-5">
            <p className="text-sm font-medium text-ink-700">Documentos adjuntos</p>
            {puedeSubirEvidencia && (
              <button
                onClick={() => docRef.current?.click()}
                disabled={subiendo}
                className="btn-secondary !py-1.5 !text-xs"
              >
                <Paperclip className="h-3.5 w-3.5" /> {subiendo ? "Subiendo..." : "Subir archivo"}
              </button>
            )}
          </div>
          {task.attachments.length === 0 ? (
            <p className="text-sm text-ink-400">No hay documentos adjuntos.</p>
          ) : (
            <div className="space-y-2">
              {task.attachments.map((doc) => {
                const autor = userById(doc.uploadedBy);
                const puedeBorrar = puedeModerarEvidencia || doc.uploadedBy === currentUser?.id;
                return (
                  <div key={doc.id} className="flex items-center gap-3 rounded-xl border border-ink-100 px-3 py-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-ink-500" />
                    <div className="min-w-0 flex-1">
                      {doc.url ? (
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-sm font-medium text-brand-700 hover:underline"
                        >
                          {doc.name}
                        </a>
                      ) : (
                        <p className="truncate text-sm font-medium text-ink-800">{doc.name}</p>
                      )}
                      <p className="truncate text-xs text-ink-400">
                        {autor?.name ?? "—"} · {timeAgo(doc.uploadedAt)}
                      </p>
                    </div>
                    {puedeBorrar && (
                      <button
                        onClick={async () => {
                          const err = await removeEvidence(task.id, doc.id);
                          if (err) setAviso(err);
                        }}
                        aria-label={`Eliminar ${doc.name}`}
                        className="shrink-0 text-ink-400 hover:text-rose-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <TaskFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        eventId={task.eventId}
        task={task}
      />
    </Modal>
  );
}
