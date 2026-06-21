import React, { useState, useEffect, useRef } from "react";
import Shell from "@/components/layout/Shell";
import { useAuth } from "@/lib/AuthContext";
import { getContacts, getDirectMessages, sendDirectMessage } from "@/lib/api";
import { 
  MessageSquare, 
  Send, 
  RefreshCw, 
  User,
  Search,
  Users,
  Clock
} from "lucide-react";

const renderFormattedContent = (content) => {
  if (!content) return null;
  
  const lines = content.split('\n');
  const elements = [];
  
  let inCodeBlock = false;
  let codeBlockLines = [];
  let codeLanguage = '';
  
  const renderInlineFormatting = (text) => {
    // 1. Process inline code `code`
    const codeParts = text.split(/(`[^`]+`)/g);
    return codeParts.flatMap((cp, cpIdx) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return (
          <code key={`code-${cpIdx}`} className="bg-slate-100 text-risk-red px-1.5 py-0.5 rounded font-mono text-[11px] border border-slate-200">
            {cp.slice(1, -1)}
          </code>
        );
      }
      
      // 2. Process bold **bold**
      const boldParts = cp.split(/(\*\*.*?\*\*)/g);
      return boldParts.flatMap((bp, bpIdx) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          return (
            <strong key={`bold-${bpIdx}`} className="font-bold">
              {bp.slice(2, -2)}
            </strong>
          );
        }
        
        // 3. Process italic *italic* or _italic_
        const italicParts = bp.split(/(\*.*?\*|_.*?_)/g);
        return italicParts.map((ip, ipIdx) => {
          if ((ip.startsWith('*') && ip.endsWith('*')) || (ip.startsWith('_') && ip.endsWith('_'))) {
            return (
              <em key={`italic-${ipIdx}`} className="italic opacity-90">
                {ip.slice(1, -1)}
              </em>
            );
          }
          return ip;
        });
      });
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for code block boundary
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        const codeText = codeBlockLines.join('\n');
        elements.push(
          <div key={`code-block-${i}`} className="my-3 rounded-lg overflow-hidden border border-slate-700/30 bg-slate-900 shadow-sm font-mono text-[12px]">
            {codeLanguage && (
              <div className="bg-slate-800 text-slate-450 px-4 py-1.5 text-[10px] font-bold border-b border-slate-700/50 uppercase select-none">
                {codeLanguage}
              </div>
            )}
            <pre className="p-4 overflow-x-auto text-slate-100 select-text whitespace-pre leading-normal">
              <code>{codeText}</code>
            </pre>
          </div>
        );
        inCodeBlock = false;
        codeBlockLines = [];
        codeLanguage = '';
      } else {
        inCodeBlock = true;
        codeLanguage = line.trim().slice(3).trim();
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }
    
    const trimmedLine = line.trimStart();
    const leadingSpaces = line.length - trimmedLine.length;
    
    // Check for blockquote
    if (trimmedLine.startsWith('>')) {
      const quoteText = trimmedLine.slice(1).trim();
      elements.push(
        <blockquote key={i} className="border-l-4 border-slate-300 pl-3 italic opacity-80 my-2 leading-relaxed text-[12.5px]">
          {renderInlineFormatting(quoteText)}
        </blockquote>
      );
      continue;
    }
    
    // Check for lists (numbered, bullet, or asterisk)
    const listMatch = trimmedLine.match(/^(\d+\.|\*|-|•)\s+(.*)/);
    if (listMatch) {
      const bullet = listMatch[1];
      const rest = listMatch[2];
      
      const isUnordered = bullet === '*' || bullet === '-' || bullet === '•';
      
      if (isUnordered) {
        elements.push(
          <div 
            key={i} 
            className="flex items-start gap-2 my-1.5 leading-relaxed text-[12.5px]"
            style={{ marginLeft: `${leadingSpaces > 0 ? (leadingSpaces * 8) + 16 : 16}px` }}
          >
            <span className="shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-current opacity-60" />
            <span className="flex-1">{renderInlineFormatting(rest)}</span>
          </div>
        );
      } else {
        elements.push(
          <div 
            key={i} 
            className="flex items-start gap-2 my-1.5 leading-relaxed text-[12.5px]"
            style={{ marginLeft: `${leadingSpaces > 0 ? (leadingSpaces * 8) + 16 : 16}px` }}
          >
            <span className="font-semibold shrink-0 select-none min-w-[15px] opacity-80">{bullet}</span>
            <span className="flex-1">{renderInlineFormatting(rest)}</span>
          </div>
        );
      }
      continue;
    }
    
    // Handle horizontal line
    if (trimmedLine === '---' || trimmedLine === '***' || trimmedLine === '___') {
      elements.push(<hr key={i} className="my-4 border-t border-border/85" />);
      continue;
    }
    
    // Handle empty line spacing
    if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
      continue;
    }
    
    // Standard paragraph
    elements.push(
      <p key={i} className="my-1.5 leading-relaxed text-[12.5px]">
        {renderInlineFormatting(line)}
      </p>
    );
  }
  
  return elements;
};

export default function MessagingPage() {
  const { user, userRole } = useAuth();
  
  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const messagesEndRef = useRef(null);

  // Fetch contacts on mount
  useEffect(() => {
    fetchContacts();
  }, []);

  // Fetch messages when contact is selected
  useEffect(() => {
    if (selectedContact) {
      fetchMessages(selectedContact.id);
    }
  }, [selectedContact]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchContacts = async () => {
    setLoadingContacts(true);
    try {
      const data = await getContacts();
      setContacts(data || []);
    } catch (err) {
      console.error("Failed to fetch contacts:", err);
    } finally {
      setLoadingContacts(false);
    }
  };

  const fetchMessages = async (contactId) => {
    setLoadingMessages(true);
    try {
      const data = await getDirectMessages(contactId);
      setMessages(data || []);
    } catch (err) {
      console.error("Failed to fetch messages:", err);
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedContact || sending) return;

    setSending(true);
    try {
      await sendDirectMessage(selectedContact.id, newMessage.trim());
      setNewMessage("");
      fetchMessages(selectedContact.id);
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  };

  const filteredContacts = contacts.filter(c => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return c.name?.toLowerCase().includes(term) || c.email?.toLowerCase().includes(term);
  });

  const formatTime = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";

  return (
    <Shell>
      <div className="flex flex-col" style={{ height: "calc(100vh - 140px)" }}>
        
        {/* Page Header */}
        <div className="mb-4">
          <h1 className="text-2xl font-bold tracking-tight text-primary">Messages</h1>
          <p className="text-[13px] text-text-secondary">
            {userRole === "client" 
              ? "Chat directly with lawyers connected through your appointments." 
              : "Communicate with clients who have booked consultations with you."}
          </p>
        </div>

        {/* Chat Layout */}
        <div className="flex-1 flex border border-border rounded-lg overflow-hidden bg-white shadow-sm min-h-0">
          
          {/* LEFT: Contact List */}
          <div className="w-80 border-r border-border flex flex-col shrink-0 bg-slate-50">
            {/* Search */}
            <div className="p-3 border-b border-border bg-white">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-text-muted absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  placeholder="Search contacts..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-[12px] border border-border rounded bg-slate-50 focus:outline-none focus:border-primary placeholder-text-muted"
                />
              </div>
            </div>

            {/* Contact List */}
            <div className="flex-1 overflow-y-auto">
              {loadingContacts ? (
                <div className="p-8 flex flex-col items-center justify-center">
                  <RefreshCw className="w-5 h-5 text-primary animate-spin mb-2" />
                  <span className="text-[11px] text-text-secondary">Loading contacts...</span>
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="p-8 flex flex-col items-center justify-center text-center">
                  <Users className="w-8 h-8 text-text-muted mb-3" />
                  <h3 className="font-semibold text-[13px] text-primary mb-1">No Contacts Yet</h3>
                  <p className="text-[11px] text-text-secondary max-w-[200px] leading-relaxed">
                    {userRole === "client"
                      ? "Schedule a consultation with a lawyer from the Appointments page to start messaging."
                      : "Contacts will appear here once clients book appointments with you."}
                  </p>
                </div>
              ) : (
                filteredContacts.map((contact) => (
                  <button
                    key={contact.id}
                    onClick={() => setSelectedContact(contact)}
                    className={`w-full px-4 py-3.5 flex items-center gap-3 text-left transition-colors border-b border-border/40 ${
                      selectedContact?.id === contact.id
                        ? "bg-primary-100 border-l-2 border-l-primary"
                        : "hover:bg-white"
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                      {contact.name?.slice(0, 2).toUpperCase() || "??"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="font-semibold text-[12.5px] text-primary truncate">{contact.name}</h4>
                      <p className="text-[10px] text-text-secondary truncate">
                        {contact.role === "lawyer" ? contact.specialty || "Legal Counsel" : "Client"}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* RIGHT: Chat Area */}
          <div className="flex-1 flex flex-col min-w-0">
            {!selectedContact ? (
              /* No contact selected state */
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-slate-50/50">
                <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center mb-4">
                  <MessageSquare className="w-7 h-7 text-primary" />
                </div>
                <h3 className="font-bold text-[15px] text-primary mb-1">Select a Conversation</h3>
                <p className="text-[12px] text-text-secondary max-w-sm leading-relaxed">
                  Choose a contact from the left panel to start or continue a conversation.
                </p>
              </div>
            ) : (
              <>
                {/* Chat Header */}
                <div className="px-5 py-3.5 border-b border-border flex items-center gap-3 bg-white shrink-0">
                  <div className="w-9 h-9 rounded-full bg-primary flex items-center justify-center text-white text-[11px] font-bold">
                    {selectedContact.name?.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-bold text-[13px] text-primary">{selectedContact.name}</h3>
                    <p className="text-[10px] text-text-secondary">
                      {selectedContact.role === "lawyer" ? selectedContact.specialty || "Legal Counsel" : "Client"} · {selectedContact.email}
                    </p>
                  </div>
                </div>

                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50/30 min-h-0">
                  {loadingMessages ? (
                    <div className="flex items-center justify-center py-12">
                      <RefreshCw className="w-5 h-5 text-primary animate-spin" />
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <MessageSquare className="w-8 h-8 text-text-muted mb-2" />
                      <p className="text-[12px] text-text-secondary">
                        No messages yet. Start the conversation!
                      </p>
                    </div>
                  ) : (
                    messages.map((msg) => {
                      const isMine = msg.sender_id === user?.id;
                      return (
                        <div
                          key={msg.id}
                          className={`flex ${isMine ? "justify-end" : "justify-start"}`}
                        >
                          <div className={`max-w-[70%] ${isMine ? "order-2" : ""}`}>
                            <div
                              className={`px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed shadow-xs ${
                                isMine
                                  ? "bg-primary text-white rounded-br-md"
                                  : "bg-white border border-border text-primary rounded-bl-md"
                              }`}
                            >
                              {renderFormattedContent(msg.content)}
                            </div>
                            <div className={`flex items-center gap-1.5 mt-1 px-1 ${isMine ? "justify-end" : ""}`}>
                              <span className="text-[9px] text-text-muted">
                                {isMine ? "You" : msg.sender_name}
                              </span>
                              <span className="text-[9px] text-text-muted">·</span>
                              <span className="text-[9px] text-text-muted">
                                {formatTime(msg.created_at)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Message Input */}
                <form onSubmit={handleSend} className="p-3 border-t border-border bg-white flex gap-2 shrink-0">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder={`Message ${selectedContact.name}...`}
                    className="flex-1 px-4 py-2.5 border border-border rounded-full text-[13px] bg-slate-50 focus:outline-none focus:border-primary focus:bg-white transition-colors placeholder-text-muted"
                  />
                  <button
                    type="submit"
                    disabled={!newMessage.trim() || sending}
                    className="px-4 py-2.5 bg-primary text-white rounded-full hover:bg-primary-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-[12px] font-semibold shadow-xs"
                  >
                    {sending ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>Send</span>
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
