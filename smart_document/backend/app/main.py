import os
import uuid
import json
import time
import hashlib
import asyncio
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Depends, Security
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# Import custom modules
from app.core.config import settings
from app.services.pdf_parser import PDFParser
from app.services.llm_client import LLMClient
from app.agents.summary_agent import SummaryAgent
from app.agents.risk_agent import RiskAgent
from app.agents.clause_agent import ClauseAgent
from app.agents.db_agent import DBAgent, MissingDBCredentialsError
from app.services.report_generator import generate_report
from app.models.schemas import (
    FinalAnalysisResponse, AnalyzeTextRequest, LLMResponse,
    AppointmentResponse, AppointmentCreate, AppointmentUpdate, PaymentVerifyRequest,
    ContactResponse, DirectMessageCreate, DirectMessageResponse,
    LawyerResponse,
    NoteCreate, NoteUpdate, NoteResponse,
    MessageCreate, MessageResponse, ShareRequest,
    DealCreate, DealResponse, SemanticDiffResponse,
    NegotiateStartRequest, NegotiateChatRequest, NegotiateChatResponse,
    PortfolioAnalyticsResponse, AnalyticsTrendPoint, CounterpartyRiskItem,
    RiskSeverityDistribution
)


# ---------------------------------------------------------------------------
# Application Lifespan (startup / shutdown hooks)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Runs on application startup and shutdown."""
    logger.info("🚀  Lexicon AI Backend v2.1.0 starting up...")
    logger.info(f"   LLM Model  : {settings.GROQ_MODEL}")
    logger.info(f"   Base URL   : {settings.GROQ_BASE_URL or 'default (Groq)'}")
    logger.info(f"   Supabase   : {'configured' if settings.SUPABASE_URL else 'disabled (local storage mode)'}")
    yield
    logger.info("Lexicon AI Backend shutting down.")


app = FastAPI(
    title="Lexicon AI Backend API",
    description="AI-powered legal document analysis, risk scoring, and contract intelligence.",
    version="2.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS Middleware
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# In-Memory Rate Limiter (100 requests / minute per IP)
# ---------------------------------------------------------------------------
class InMemoryRateLimiter:
    """Simple sliding-window rate limiter with automatic stale-entry cleanup."""

    def __init__(self, requests_limit: int, window_seconds: int):
        self.requests_limit = requests_limit
        self.window_seconds = window_seconds
        self.requests: dict[str, list[float]] = defaultdict(list)
        self._last_cleanup = time.time()

    def is_allowed(self, ip: str) -> bool:
        now = time.time()
        # Periodic cleanup of stale IPs every 5 minutes to prevent memory leak
        if now - self._last_cleanup > 300:
            self._cleanup_stale(now)
        # Slide window
        self.requests[ip] = [t for t in self.requests[ip] if now - t < self.window_seconds]
        if len(self.requests[ip]) >= self.requests_limit:
            return False
        self.requests[ip].append(now)
        return True

    def _cleanup_stale(self, now: float):
        """Remove entries for IPs that have no recent requests."""
        stale_keys = [
            ip for ip, timestamps in self.requests.items()
            if not timestamps or now - timestamps[-1] > self.window_seconds * 2
        ]
        for key in stale_keys:
            del self.requests[key]
        self._last_cleanup = now


rate_limiter = InMemoryRateLimiter(requests_limit=100, window_seconds=60)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    path = request.url.path
    # Exclude docs and health endpoints from rate limiting
    if path.startswith("/docs") or path.startswith("/openapi.json") or path in ("/", "/health"):
        return await call_next(request)

    client_ip = request.client.host if request.client else "127.0.0.1"
    if not rate_limiter.is_allowed(client_ip):
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests. Please try again later."}
        )
    return await call_next(request)


# ---------------------------------------------------------------------------
# File System Setup
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(BASE_DIR)
UPLOADS_DIR = os.path.join(BACKEND_ROOT, "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# API Key Authentication (optional — only enforced if API_KEY env var is set)
# ---------------------------------------------------------------------------
API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)


def verify_api_key(api_key: str = Security(api_key_header)):
    """Validates the request API Key if API_KEY is defined in the environment."""
    env_api_key = os.getenv("API_KEY")
    if env_api_key:
        if not api_key or api_key != env_api_key:
            raise HTTPException(status_code=403, detail="Invalid or missing API Key.")
    return api_key


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    document_id: str
    question: str


class ChatResponse(BaseModel):
    answer: str
    sources: list[str] = []


# ---------------------------------------------------------------------------
# Health & Root Endpoints
# ---------------------------------------------------------------------------
@app.get("/", tags=["System"])
def read_root():
    return {"message": "Lexicon AI Backend API is running!", "version": "2.1.0"}


@app.get("/health", tags=["System"])
def health():
    """Health check endpoint to monitor API status."""
    return {"status": "healthy", "model": settings.GROQ_MODEL}


# ---------------------------------------------------------------------------
# Core Analysis Pipeline
# ---------------------------------------------------------------------------
def get_user_info(request: Request):
    user_id = request.headers.get("x-user-id", "default_user")
    user_role = request.headers.get("x-user-role", "lawyer")
    return {"user_id": user_id, "role": user_role}


async def run_analysis_pipeline(document_id: str, filename: str, text: str, user_id: str = "default_user") -> FinalAnalysisResponse:
    """Executes the core LLM analysis and agent-structure pipeline.
    Uses content hash caching: if the same text was analyzed before by this user, returns cached results."""

    # 0. Content hash for deduplication / caching
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

    # Check for cached analysis with same content hash
    try:
        db_agent = DBAgent()
        cached = await db_agent.find_analysis_by_hash(content_hash, user_id)
        if cached:
            logger.info(f"♻️  Cache HIT for content hash {content_hash[:12]}... — returning existing analysis {cached['document_id']}")
            # Build response from cached data
            txt_path = os.path.join(UPLOADS_DIR, f"{document_id}.txt")
            json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(cached, f, indent=2, default=str)
            return FinalAnalysisResponse.model_validate(cached)
    except Exception as e:
        logger.warning(f"Cache lookup failed (non-fatal): {str(e)}")

    # 1. Run LLM Analysis
    llm_client = LLMClient()
    try:
        llm_response: LLMResponse = await llm_client.analyze_document(text)
    except Exception as e:
        logger.error(f"LLM analysis failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"LLM analysis failed: {str(e)}")

    # 2. Run Agents
    summary_agent = SummaryAgent()
    risk_agent = RiskAgent()
    clause_agent = ClauseAgent()

    final_summary = summary_agent.process(llm_response.summary)
    final_risks = risk_agent.process(llm_response.risks)
    final_clauses = clause_agent.process(llm_response.clauses)

    # Inconsistency
    inconsistency_score = 0.0
    if llm_response.inconsistencies:
        severity_map = {"High": 3, "Medium": 2, "Low": 1}
        total_weight = sum(severity_map.get(inc.severity, 2) for inc in llm_response.inconsistencies)
        max_possible = len(llm_response.inconsistencies) * 3
        inconsistency_score = round((total_weight / max_possible) * 10, 2) if max_possible > 0 else 0.0

    # 3. Build Final Response
    response = FinalAnalysisResponse(
        document_id=document_id,
        summary=final_summary,
        risks=final_risks,
        clauses=final_clauses,
        metadata=llm_response.metadata,
        inconsistency_score=inconsistency_score,
        inconsistencies=llm_response.inconsistencies
    )
    # Ensure text is saved in metadata
    response.metadata.document_text = text

    # 4. Persist locally
    txt_path = os.path.join(UPLOADS_DIR, f"{document_id}.txt")
    json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(response.model_dump(), f, indent=2)

    # 5. Save to Supabase (graceful fallback) — with content hash
    try:
        db_agent = DBAgent()
        await db_agent.save_analysis(
            document_id=document_id,
            user_id=user_id,
            filename=filename,
            summary=response.summary.model_dump(),
            risks=[r.model_dump() for r in response.risks],
            clauses=response.clauses.model_dump(),
            metadata=response.metadata.model_dump(),
            inconsistency_score=response.inconsistency_score,
            inconsistencies=[i.model_dump() for i in response.inconsistencies],
            content_hash=content_hash
        )
        logger.info(f"✅ Analysis {document_id} persisted to Supabase (hash: {content_hash[:12]}...).")
    except MissingDBCredentialsError:
        logger.warning("Supabase credentials missing — using local cache only.")
    except Exception as e:
        logger.error(f"Supabase persistence failed: {str(e)}", exc_info=True)

    return response


# ---------------------------------------------------------------------------
# Document Upload & Analysis Endpoints
# ---------------------------------------------------------------------------
@app.post("/upload", response_model=FinalAnalysisResponse, dependencies=[Depends(verify_api_key)], tags=["Analysis"])
async def upload_pdf(file: UploadFile = File(...), request: Request = None):
    """Uploads a PDF, extracts text, runs analysis, and returns structured data."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")

    user_info = get_user_info(request) if request else {"user_id": "default_user", "role": "lawyer"}

    try:
        file_bytes = await file.read()
        # 50 MB file-size validation
        if len(file_bytes) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large. Maximum size is 50 MB.")

        extracted_text = PDFParser.extract_text(file_bytes)
        if not extracted_text or not extracted_text.strip():
            raise HTTPException(status_code=400, detail="No text found in PDF.")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to parse PDF: {str(e)}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse PDF: {str(e)}")

    document_id = str(uuid.uuid4())
    logger.info(f"📄 Processing '{file.filename}' → {document_id}")

    return await run_analysis_pipeline(document_id, file.filename, extracted_text, user_id=user_info["user_id"])


@app.post("/upload-batch", dependencies=[Depends(verify_api_key)], tags=["Analysis"])
async def upload_batch(files: list[UploadFile] = File(...), request: Request = None):
    """Uploads multiple PDFs, extracts text, runs analysis for each, links them, and returns a list of results."""
    user_info = get_user_info(request) if request else {"user_id": "default_user", "role": "lawyer"}
    
    extracted_docs = []
    for file in files:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"File {file.filename} is not a PDF.")
        
        try:
            file_bytes = await file.read()
            if len(file_bytes) > 50 * 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"File {file.filename} is too large. Max is 50 MB.")
            
            extracted_text = PDFParser.extract_text(file_bytes)
            if not extracted_text or not extracted_text.strip():
                raise HTTPException(status_code=400, detail=f"No text found in PDF {file.filename}.")
            
            extracted_docs.append((file.filename, extracted_text))
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to parse PDF {file.filename}: {str(e)}", exc_info=True)
            raise HTTPException(status_code=400, detail=f"Failed to parse PDF {file.filename}: {str(e)}")
            
    # Concurrently execute all analysis pipelines
    tasks = [
        run_analysis_pipeline(str(uuid.uuid4()), filename, text, user_id=user_info["user_id"])
        for filename, text in extracted_docs
    ]
    results = list(await asyncio.gather(*tasks))

    # Link files together in metadata if multiple files are uploaded
    if len(results) >= 2:
        group_id = str(uuid.uuid4())
        
        # Run cross-document comparison
        inconsistency_report = {}
        try:
            doc_data = []
            total_len = 0
            for r in results:
                txt_path = os.path.join(UPLOADS_DIR, f"{r.document_id}.txt")
                with open(txt_path, "r", encoding="utf-8") as f:
                    text = f.read()
                doc_data.append({"filename": r.metadata.document_type or "Document", "text": text})
                total_len += len(text)
                
            comparison_text = ""
            if total_len > 14000:
                logger.info(f"💾 Combined text size ({total_len} chars) exceeds rate limit threshold. Compiling structured summaries for comparison...")
                for idx, r in enumerate(results):
                    summary_text = f"\n--- DOCUMENT {idx+1}: {r.metadata.document_type or 'Document'} ---\n"
                    summary_text += f"Summary: {r.summary.main_summary}\n"
                    summary_text += f"Key Points: {', '.join(r.summary.key_points)}\n"
                    summary_text += "Risks Identified:\n"
                    for rk in r.risks:
                        summary_text += f"- {rk.title}: {rk.description}\n"
                    
                    summary_text += "Key Clauses (Standard):\n"
                    for cl in r.clauses.standard_clauses:
                        content_snippet = cl.content or ''
                        if len(content_snippet) > 800:
                            content_snippet = content_snippet[:800] + "... [truncated]"
                        summary_text += f"- {cl.title}: {content_snippet}\n"
                    
                    summary_text += "Key Clauses (Non-Standard):\n"
                    for cl in r.clauses.non_standard_clauses:
                        content_snippet = cl.content or ''
                        if len(content_snippet) > 800:
                            content_snippet = content_snippet[:800] + "... [truncated]"
                        summary_text += f"- {cl.title}: {content_snippet}\n"
                    comparison_text += summary_text
            else:
                for idx, doc in enumerate(doc_data):
                    comparison_text += f"\n--- DOCUMENT {idx+1}: {doc['filename']} ---\n{doc['text']}\n"
                
            llm_client = LLMClient()
            system_prompt = (
                "You are an expert legal counsel. You need to analyze the legal documents provided below "
                "and identify any conflicts, contradictions, or inconsistencies between them. Return a JSON object with this exact structure:\n\n"
                "{\n"
                '  "inconsistency_score": float,\n'
                '  "inconsistencies": [\n'
                "    {\n"
                '      "title": "Title of conflict",\n'
                '      "description": "Details",\n'
                '      "severity": "High" | "Medium" | "Low",\n'
                '      "affected_sections": ["Section X", "Section Y"]\n'
                "    }\n"
                '  ]\n'
                "}"
            )
            raw_content = await llm_client.generate_response(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"Here are the legal documents to compare:\n{comparison_text}"},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
            )
            inconsistency_report = json.loads(raw_content)
        except Exception as e:
            logger.error(f"Auto batch comparison failed: {str(e)}")

        # Update metadata of each document
        for r in results:
            json_path = os.path.join(UPLOADS_DIR, f"{r.document_id}.json")
            if os.path.exists(json_path):
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                # Setup metadata linked items
                data["metadata"]["group_id"] = group_id
                data["metadata"]["linked_docs"] = [
                    {"document_id": other.document_id, "filename": other.metadata.document_type or "Document"} 
                    for other in results if other.document_id != r.document_id
                ]
                if inconsistency_report:
                    data["metadata"]["cross_contradictions"] = inconsistency_report
                
                # Save locally
                with open(json_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                
                # Update r properties
                r.metadata.group_id = group_id
                r.metadata.linked_docs = data["metadata"]["linked_docs"]
                if inconsistency_report:
                    r.metadata.cross_contradictions = inconsistency_report
                
                # Sync to Supabase
                try:
                    db_agent = DBAgent()
                    def _update_db(doc_id, metadata_val):
                        return db_agent.client.table("analyses").update({"metadata": metadata_val}).eq("document_id", doc_id).execute()
                    
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, _update_db, r.document_id, data["metadata"])
                except Exception as e:
                    logger.error(f"Failed to sync batch link metadata: {str(e)}")
                    
    return results


@app.post("/analyze", response_model=FinalAnalysisResponse, dependencies=[Depends(verify_api_key)], tags=["Analysis"])
async def analyze_text(req: AnalyzeTextRequest, request: Request):
    """Analyzes raw contract text and returns structured data."""
    if not req.content or not req.content.strip():
        raise HTTPException(status_code=400, detail="Document content cannot be empty.")

    user_info = get_user_info(request)
    document_id = str(uuid.uuid4())
    logger.info(f"📝 Processing pasted text → {document_id}")

    return await run_analysis_pipeline(document_id, "Pasted_Contract.txt", req.content, user_id=user_info["user_id"])


# ---------------------------------------------------------------------------
# Retrieval Endpoints
# ---------------------------------------------------------------------------
async def ensure_local_files(document_id: str) -> bool:
    """
    Checks if the local .json and .txt files exist for a document_id.
    If missing, attempts to retrieve the analysis from Supabase and reconstruct them.
    Returns True if files exist or were successfully recreated, False otherwise.
    """
    json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")
    txt_path = os.path.join(UPLOADS_DIR, f"{document_id}.txt")

    if os.path.exists(json_path) and os.path.exists(txt_path):
        return True

    # Try fetching from Supabase
    try:
        db_agent = DBAgent()
        analysis_data = await db_agent.get_analysis(document_id)
        if not analysis_data:
            logger.warning(f"Document {document_id} not found in Supabase.")
            return False

        metadata = analysis_data.get("metadata", {})
        document_text = metadata.get("document_text", "")

        # Write to txt file if missing
        if not os.path.exists(txt_path) and document_text:
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(document_text)

        # Write to json file if missing
        if not os.path.exists(json_path):
            response_dict = {
                "document_id": document_id,
                "summary": analysis_data.get("summary", {}),
                "risks": analysis_data.get("risks", []),
                "clauses": analysis_data.get("clauses", {}),
                "metadata": metadata,
                "inconsistency_score": float(analysis_data.get("inconsistency_score", 0.0) or 0.0),
                "inconsistencies": analysis_data.get("inconsistencies", [])
            }
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(response_dict, f, indent=2)

        return True
    except MissingDBCredentialsError:
        logger.warning("Supabase credentials missing, cannot recreate local files.")
        return False
    except Exception as e:
        logger.error(f"Failed to restore local files for document {document_id}: {str(e)}", exc_info=True)
        return False


@app.get("/analyses/{document_id}", response_model=FinalAnalysisResponse, dependencies=[Depends(verify_api_key)], tags=["Retrieval"])
async def get_analysis(document_id: str):
    """Retrieves cached analysis by document ID."""
    await ensure_local_files(document_id)
    json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail="Analysis session not found.")

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return FinalAnalysisResponse.model_validate(data)
    except Exception as e:
        logger.error(f"Failed to load analysis: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load analysis results.")


@app.get("/analyses/{document_id}/text", dependencies=[Depends(verify_api_key)], tags=["Retrieval"])
async def get_analysis_text(document_id: str):
    """Retrieves the raw extracted text of the document."""
    await ensure_local_files(document_id)
    txt_path = os.path.join(UPLOADS_DIR, f"{document_id}.txt")
    if not os.path.exists(txt_path):
        raise HTTPException(status_code=404, detail="Document text not found.")
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            text = f.read()
        return {"text": text}
    except Exception as e:
        logger.error(f"Failed to read text file: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load document text.")


# ---------------------------------------------------------------------------
# Inconsistency / Comparison Endpoint
# ---------------------------------------------------------------------------
class CompareRequest(BaseModel):
    document_ids: list[str]

@app.post("/compare", dependencies=[Depends(verify_api_key)], tags=["Analysis"])
async def compare_documents(req: CompareRequest):
    """Compares multiple documents to detect cross-document inconsistencies and contradictions."""
    if len(req.document_ids) < 2:
        raise HTTPException(status_code=400, detail="At least two documents must be selected for comparison.")

    doc_data = []
    for doc_id in req.document_ids:
        await ensure_local_files(doc_id)
        txt_path = os.path.join(UPLOADS_DIR, f"{doc_id}.txt")
        json_path = os.path.join(UPLOADS_DIR, f"{doc_id}.json")
        if not os.path.exists(txt_path) or not os.path.exists(json_path):
            raise HTTPException(status_code=404, detail=f"Document {doc_id} not found.")
        
        with open(txt_path, "r", encoding="utf-8") as f:
            text = f.read()
        with open(json_path, "r", encoding="utf-8") as f:
            meta = json.load(f).get("metadata", {})
            filename = meta.get("document_type", "Document") + f" ({doc_id[:8]})"
            
        doc_data.append({"filename": filename, "text": text})

    llm_client = LLMClient()
    comparison_text = ""
    for idx, doc in enumerate(doc_data):
        comparison_text += f"\n--- DOCUMENT {idx+1}: {doc['filename']} ---\n{doc['text']}\n"

    system_prompt = (
        "You are an expert legal counsel. You need to analyze the legal documents provided below "
        "and identify any conflicts, contradictions, or inconsistencies between them. Examples of conflicts "
        "include mismatched liability limits, differing payment terms, conflicting dispute resolution jurisdictions, "
        "or contradictory effective dates/termination clauses. Return a JSON object with this exact structure:\n\n"
        "{\n"
        '  "inconsistency_score": float,  # A score from 0.0 (perfectly consistent) to 10.0 (severe conflicts)\n'
        '  "inconsistencies": [\n'
        "    {\n"
        '      "title": "Title of conflict",\n'
        '      "description": "Details about the conflict, explaining what conflicts in Doc A vs Doc B",\n'
        '      "severity": "High" | "Medium" | "Low",\n'
        '      "affected_sections": ["Doc 1 Section 4", "Doc 2 Section 12"]\n'
        "    }\n"
        '  ]\n'
        "}"
    )

    try:
        raw_content = await llm_client.generate_response(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Here are the legal documents to compare:\n{comparison_text}"},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
        )
        comparison_results = json.loads(raw_content)
        return comparison_results
    except Exception as e:
        logger.error(f"Cross-document comparison failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Comparison failed: {str(e)}")


# ---------------------------------------------------------------------------
# AI Chat Endpoint
# ---------------------------------------------------------------------------
@app.post("/chat", response_model=ChatResponse, dependencies=[Depends(verify_api_key)], tags=["AI Chat"])
async def chat_with_doc(req: ChatRequest, request: Request):
    """Queries the document text or answers general legal questions with AI."""
    
    # Check if it's general chat mode
    is_general = not req.document_id or str(req.document_id).strip().lower() in ("general", "none", "null", "")
    
    if is_general:
        user_info = get_user_info(request)
        user_id = user_info["user_id"]
        user_role = user_info["role"]
        
        db_agent = DBAgent()
        analyses_context = ""
        lawyer_context = ""
        try:
            if user_role == "client":
                analyses = await db_agent.list_shared_analyses(client_id=user_id)
            else:
                analyses = await db_agent.list_analyses(user_id=user_id)
            
            if analyses:
                analyses_context = "Here are the user's uploaded legal documents in their workspace:\n"
                for a in analyses[:10]:
                    analyses_context += f"- Document: {a.get('filename')}, Type: {a.get('document_type')}, Risk Score: {a.get('risk_score')}/10.0, ID: {a.get('document_id')}\n"
            else:
                analyses_context = "The user has no legal documents uploaded or shared in their workspace yet.\n"
        except Exception as e:
            logger.error(f"Failed to query analyses context for chatbot: {e}")
            
        try:
            contacts = await db_agent.get_contacts(user_id=user_id, role=user_role)
            if contacts:
                party_type = "Lawyers" if user_role == "client" else "Clients"
                lawyer_context = f"Here are the connected {party_type} for this user in their workspace:\n"
                for c in contacts:
                    lawyer_context += f"- Name: {c.get('name')}, Email: {c.get('email')}, Phone: {c.get('phone') or 'Not shared'}"
                    if c.get("specialty"):
                        lawyer_context += f", Specialty: {c.get('specialty')}"
                    lawyer_context += f", ID: {c.get('id')}\n"
            else:
                party_type = "lawyer" if user_role == "client" else "client"
                lawyer_context = f"The user does not have any connected {party_type} matched through appointments yet.\n"
        except Exception as e:
            logger.error(f"Failed to query contacts context for chatbot: {e}")

        system_prompt = (
            "You are LexiconAI's expert AI Legal Assistant. You help users understand legal concepts, "
            "compliance requirements, contract clauses, and platform features. Answer questions clearly, "
            "professionally, and outline standard legal best practices when requested.\n\n"
            "Here is the workspace context of the active user session:\n"
            f"{analyses_context}\n"
            f"{lawyer_context}\n"
            "Answer questions using this context if the user asks about their documents, connected lawyers/clients, "
            "or status updates. If they ask about standard legal concepts (like NDAs, liability, or indemnification), "
            "provide expert guidance. Advise the user to consult their lawyer for formal legal counsel when appropriate."
        )
    else:
        await ensure_local_files(req.document_id)
        txt_path = os.path.join(UPLOADS_DIR, f"{req.document_id}.txt")
        if not os.path.exists(txt_path):
            # Fallback to general chat if document is missing
            is_general = True
            system_prompt = (
                "You are LexiconAI's expert AI Legal Assistant. You help users understand legal concepts. "
                "(The requested document context was not found, so you are responding in general advisory mode.)"
            )
        else:
            try:
                with open(txt_path, "r", encoding="utf-8") as f:
                    document_text = f.read()
                
                # Smart truncation for large documents to stay within free-tier TPM limits (e.g. 6,000 tokens)
                max_chars = 14000
                if len(document_text) > max_chars:
                    logger.warning(f"⚠️ Chat contract text length ({len(document_text)} chars) exceeds safe threshold ({max_chars} chars) for TPM limits. Truncating document context for chat...")
                    document_text = (
                        document_text[:10000]
                        + "\n\n... [TRUNCATED MIDDLE CONTENT TO STAY WITHIN API LIMITS] ...\n\n"
                        + document_text[-4000:]
                    )
            except Exception as e:
                logger.error(f"Failed to read contract text: {str(e)}", exc_info=True)
                raise HTTPException(status_code=500, detail="Failed to load document text.")
            
            system_prompt = (
                "You are an expert AI legal assistant. You are helping a user analyze a legal contract.\n"
                "Below is the full text of the legal contract:\n\n"
                f"--- START CONTRACT ---\n{document_text}\n--- END CONTRACT ---\n\n"
                "Answer the user's question accurately using only the contract text when possible. "
                "If the information is not in the contract, explain that it cannot be found in the document. "
                "Be clear, professional, and highlight specific section numbers or references if they exist."
            )

    llm_client = LLMClient()
    try:
        answer = await llm_client.generate_response(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": req.question},
            ],
            temperature=0.2,
        )
        return ChatResponse(answer=answer, sources=[])
    except Exception as e:
        logger.error(f"LLM chat query failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to query advisor: {str(e)}")


# ---------------------------------------------------------------------------
# Notes Endpoints
# ---------------------------------------------------------------------------
from app.models.schemas import NoteCreate, NoteUpdate, NoteResponse

@app.get("/notes/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def get_notes(document_id: str, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.get_notes(document_id, user_id=user_info["user_id"])
    except Exception as e:
        logger.error(f"Failed to get notes: {str(e)}")
        return []

@app.post("/notes/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def create_note(document_id: str, req: NoteCreate, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        doc_id = document_id
        if doc_id and str(doc_id).strip().lower() in ("none", "null", ""):
            doc_id = None
        return await db_agent.save_note(doc_id, user_info["user_id"], req.content)
    except Exception as e:
        logger.error(f"Failed to save note: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to save note: {str(e)}")

@app.post("/notes", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def create_general_note(req: NoteCreate, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        doc_id = req.document_id
        if doc_id and str(doc_id).strip().lower() in ("none", "null", ""):
            doc_id = None
        return await db_agent.save_note(doc_id, user_info["user_id"], req.content)
    except Exception as e:
        logger.error(f"Failed to save note: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to save note: {str(e)}")

@app.put("/notes/{note_id}", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def update_note(note_id: int, req: NoteUpdate, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.update_note(note_id, user_info["user_id"], req.content)
    except Exception as e:
        logger.error(f"Failed to update note: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update note: {str(e)}")

@app.delete("/notes/{note_id}", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def delete_note(note_id: int, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        await db_agent.delete_note(note_id, user_info["user_id"])
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to delete note: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete note: {str(e)}")

@app.get("/notes", dependencies=[Depends(verify_api_key)], tags=["Notes"])
async def list_all_notes(request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.list_all_notes(user_info["user_id"])
    except Exception as e:
        logger.error(f"Failed to list all notes: {str(e)}")
        return []


# ---------------------------------------------------------------------------
# Collaboration & Sharing Endpoints
# ---------------------------------------------------------------------------
# (Models imported at top of file)


class CompleteProfileRequest(BaseModel):
    name: str
    role: str  # 'lawyer' or 'client'

@app.post("/messages/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Collaboration"])
async def send_message(document_id: str, req: MessageCreate, request: Request):
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.send_message(
            document_id=document_id,
            sender_id=user_info["user_id"],
            sender_role=user_info["role"],
            sender_name=req.sender_name,
            content=req.content
        )
    except Exception as e:
        logger.error(f"Failed to send message: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to send message: {str(e)}")

@app.get("/messages/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Collaboration"])
async def get_messages(document_id: str):
    db_agent = DBAgent()
    try:
        return await db_agent.get_messages(document_id)
    except Exception as e:
        logger.error(f"Failed to get messages: {str(e)}")
        return []

@app.post("/share/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Collaboration"])
async def share_document(document_id: str, req: ShareRequest, request: Request):
    user_info = get_user_info(request)
    if user_info["role"] != "lawyer":
        raise HTTPException(status_code=403, detail="Only lawyers can share documents.")
    db_agent = DBAgent()
    try:
        shared = await db_agent.share_document(
            document_id=document_id,
            lawyer_id=user_info["user_id"],
            client_email=req.client_email
        )
        return {"success": True, "shared": shared}
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to share document: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to share document: {str(e)}")


# ---------------------------------------------------------------------------
# List All Analyses (for Dashboard / History / Library)
# ---------------------------------------------------------------------------
@app.get("/analyses", dependencies=[Depends(verify_api_key)], tags=["Retrieval"])
async def list_analyses(user_id: str = None, limit: int = 50, request: Request = None):
    """Lists all completed analyses, optionally filtered by user_id. Clients see only shared documents."""
    user_info = get_user_info(request) if request else {"user_id": None, "role": "lawyer"}
    
    # Try Supabase first
    try:
        db_agent = DBAgent()
        if user_info["role"] == "client":
            analyses = await db_agent.list_shared_analyses(client_id=user_info["user_id"])
        else:
            analyses = await db_agent.list_analyses(user_id=user_id or user_info["user_id"], limit=limit)
        
        # Include notes count for each analysis
        notes_counts = await db_agent.get_notes_count_map(user_info["user_id"])
        for a in analyses:
            a["notes_count"] = notes_counts.get(a["document_id"], 0)
            
        return {"analyses": analyses, "total": len(analyses)}
    except MissingDBCredentialsError:
        logger.warning("Supabase not configured — falling back to local file scan.")
    except Exception as e:
        logger.error(f"Failed to list analyses from Supabase: {str(e)}", exc_info=True)

    # Fallback: scan local uploads directory for JSON files
    analyses = []
    if os.path.exists(UPLOADS_DIR):
        for fname in os.listdir(UPLOADS_DIR):
            if fname.endswith(".json"):
                doc_id = fname.replace(".json", "")
                json_path = os.path.join(UPLOADS_DIR, fname)
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    analyses.append({
                        "document_id": doc_id,
                        "filename": data.get("metadata", {}).get("document_type", "Unknown") + ".pdf",
                        "document_type": data.get("metadata", {}).get("document_type", "Unknown"),
                        "risk_score": 0,
                        "status": "completed",
                        "created_at": None,
                        "notes_count": 0
                    })
                except Exception:
                    pass
    return {"analyses": analyses, "total": len(analyses)}


# ---------------------------------------------------------------------------
# PDF Report Generation
# ---------------------------------------------------------------------------
@app.get("/report/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Reports"])
def get_pdf_report(document_id: str):
    """Generates and returns the PDF audit report for a completed analysis."""
    json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail="Analysis results not found.")

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        summary = data.get("summary", {})
        risks = data.get("risks", [])
        clauses = data.get("clauses", {})
        metadata = data.get("metadata", {})

        pdf_path = generate_report(document_id, summary, risks, clauses, metadata)

        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=f"lexicon_analysis_{document_id}.pdf",
        )
    except Exception as e:
        logger.error(f"Error generating report: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate report: {str(e)}")


# ---------------------------------------------------------------------------
# Lawyers and Appointments Endpoints
# ---------------------------------------------------------------------------

@app.get("/lawyers", response_model=list[LawyerResponse], tags=["Lawyers & Appointments"])
async def get_lawyers_list():
    """Retrieve list of all registered lawyers."""
    db_agent = DBAgent()
    try:
        return await db_agent.get_lawyers()
    except Exception as e:
        logger.error(f"Failed to fetch lawyers list: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch lawyers list: {str(e)}")


@app.get("/appointments", response_model=list[AppointmentResponse], dependencies=[Depends(verify_api_key)], tags=["Lawyers & Appointments"])
async def get_appointments(request: Request):
    """Retrieve appointments for the current user."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.get_appointments(user_id=user_info["user_id"], role=user_info["role"])
    except Exception as e:
        logger.error(f"Failed to fetch appointments: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch appointments: {str(e)}")


@app.post("/appointments", response_model=AppointmentResponse, dependencies=[Depends(verify_api_key)], tags=["Lawyers & Appointments"])
async def create_appointment(req: AppointmentCreate, request: Request):
    """Create a new appointment request. Clients can optionally choose a lawyer or leave blank for auto-assignment."""
    user_info = get_user_info(request)
    
    if user_info["role"] == "client":
        client_id = user_info["user_id"]
        lawyer_id = req.lawyer_id  # May be None for auto-assignment
    elif user_info["role"] == "lawyer":
        if not req.client_id:
            raise HTTPException(status_code=400, detail="client_id is required when scheduled by a lawyer.")
        client_id = req.client_id
        lawyer_id = user_info["user_id"]
    else:
        raise HTTPException(status_code=403, detail="Unauthorized role.")
        
    db_agent = DBAgent()
    
    # Auto-assign lawyer if not specified (least-busy available lawyer)
    if not lawyer_id:
        try:
            best_lawyer = await db_agent.get_least_busy_lawyer()
            if not best_lawyer:
                raise HTTPException(status_code=404, detail="No lawyers are currently available. Please try again later.")
            lawyer_id = best_lawyer["id"]
            logger.info(f"🤖 Auto-assigned lawyer: {best_lawyer['name']} ({best_lawyer['id']})")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Auto-assignment failed: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to auto-assign lawyer: {str(e)}")
    
    # Fetch profiles for names and email notifications
    client_email = "client@lexicon.com"
    client_name = "Client"
    lawyer_email = "lawyer@lexicon.com"
    lawyer_name = "Lawyer"
    
    try:
        loop = asyncio.get_running_loop()
        def _fetch_profile(uid):
            return db_agent.client.table("profiles").select("email, name").eq("id", uid).single().execute()
            
        try:
            c_res = await loop.run_in_executor(None, _fetch_profile, client_id)
            if c_res.data:
                client_email = c_res.data.get("email", client_email)
                client_name = c_res.data.get("name", client_name)
        except Exception:
            pass
            
        try:
            l_res = await loop.run_in_executor(None, _fetch_profile, lawyer_id)
            if l_res.data:
                lawyer_email = l_res.data.get("email", lawyer_email)
                lawyer_name = l_res.data.get("name", lawyer_name)
        except Exception:
            pass
    except Exception:
        pass

    logger.info("📧 SIMULATED APPOINTMENT BOOKING NOTIFICATION EMAILS SENT:")
    logger.info(f"   To Client: {client_name} <{client_email}>")
    logger.info(f"   To Lawyer: {lawyer_name} <{lawyer_email}>")
    logger.info(f"   Subject: Consultation Scheduled: {req.title}")
    logger.info(f"   Details: {req.appointment_date} at {req.appointment_time} (Google Meet links generated)")
    
    try:
        return await db_agent.create_appointment(
            client_id=client_id,
            lawyer_id=lawyer_id,
            client_name=client_name,
            lawyer_name=lawyer_name,
            title=req.title,
            description=req.description,
            date=req.appointment_date,
            time=req.appointment_time,
            share_phone_with_lawyer=req.share_phone_with_lawyer
        )
    except Exception as e:
        logger.error(f"Failed to schedule appointment: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to schedule appointment: {str(e)}")


@app.put("/appointments/{appointment_id}", response_model=AppointmentResponse, dependencies=[Depends(verify_api_key)], tags=["Lawyers & Appointments"])
async def update_appointment_status(appointment_id: int, req: AppointmentUpdate, request: Request):
    """Update appointment status (Completed, Cancelled)."""
    db_agent = DBAgent()
    try:
        return await db_agent.update_appointment(appointment_id=appointment_id, status=req.status)
    except Exception as e:
        logger.error(f"Failed to update appointment status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update appointment: {str(e)}")


# ---------------------------------------------------------------------------
# Payment Integration Endpoints
# ---------------------------------------------------------------------------
import hmac
import httpx
import base64

@app.post("/payments/create-order/{appointment_id}", tags=["Payments"])
async def create_payment_order(appointment_id: int):
    """Creates a Razorpay order for an appointment's consultation fee."""
    db_agent = DBAgent()
    
    # 1. Fetch appointment details
    try:
        supabase_client = db_agent.client
        loop = asyncio.get_running_loop()
        def _fetch():
            return supabase_client.table("appointments").select("*").eq("id", appointment_id).single().execute()
        
        appt_res = await loop.run_in_executor(None, _fetch)
        appt = appt_res.data
        if not appt:
            raise HTTPException(status_code=404, detail="Appointment not found.")
    except Exception as e:
        logger.error(f"Failed to find appointment {appointment_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to find appointment: {str(e)}")
        
    # Check if already paid
    if appt.get("payment_status") == "paid":
        return {"message": "Appointment already paid", "status": "paid"}
        
    # Calculate amount in paise (default is 500.00 INR -> 50000 paise)
    fee = float(appt.get("consultation_fee") or 500.00)
    amount_paise = int(fee * 100)
    
    # Get Razorpay credentials from environment
    razorpay_key_id = os.getenv("RAZORPAY_KEY_ID") or os.getenv("Test Key ID") or "rzp_test_T3kbOWjN6XNT4w"
    razorpay_key_secret = os.getenv("RAZORPAY_KEY_SECRET") or os.getenv("Test Key Secret") or "mrG2DW1dubznFfdqF0NJEygU"
    
    if not razorpay_key_id or not razorpay_key_secret:
         raise HTTPException(status_code=500, detail="Razorpay credentials not configured on backend.")
         
    # Call Razorpay API to create an order
    url = "https://api.razorpay.com/v1/orders"
    auth_str = f"{razorpay_key_id}:{razorpay_key_secret}"
    auth_bytes = auth_str.encode('utf-8')
    auth_b64 = base64.b64encode(auth_bytes).decode('utf-8')
    
    headers = {
        "Authorization": f"Basic {auth_b64}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "amount": amount_paise,
        "currency": "INR",
        "receipt": f"receipt_appt_{appointment_id}"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                logger.error(f"Razorpay Order API error: {response.text}")
                raise HTTPException(status_code=502, detail=f"Razorpay Order creation failed: {response.text}")
                
            order_data = response.json()
            order_id = order_data["id"]
        except Exception as e:
            if isinstance(e, HTTPException):
                raise
            logger.error(f"Failed to call Razorpay API: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to communicate with payment processor: {str(e)}")
            
    # Update the appointment in DB with the razorpay_order_id
    try:
        await db_agent.update_appointment_payment(
            appointment_id=appointment_id,
            payment_status="unpaid",
            razorpay_order_id=order_id
        )
    except Exception as e:
        logger.error(f"Failed to update appointment with order ID: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to save payment order ID.")
        
    return {
        "order_id": order_id,
        "amount": amount_paise,
        "currency": "INR",
        "key_id": razorpay_key_id
    }

@app.post("/payments/verify", tags=["Payments"])
async def verify_payment(req: PaymentVerifyRequest):
    """Verifies the Razorpay payment signature and updates appointment payment status."""
    db_agent = DBAgent()
    
    # Get Razorpay credentials
    razorpay_key_secret = os.getenv("RAZORPAY_KEY_SECRET") or os.getenv("Test Key Secret") or "mrG2DW1dubznFfdqF0NJEygU"
    if not razorpay_key_secret:
         raise HTTPException(status_code=500, detail="Razorpay credentials not configured on backend.")
         
    # Compute signature
    msg = f"{req.razorpay_order_id}|{req.razorpay_payment_id}"
    h = hmac.new(
        razorpay_key_secret.encode('utf-8'),
        msg.encode('utf-8'),
        hashlib.sha256
    )
    expected_signature = h.hexdigest()
    
    # Check if signature matches
    if not hmac.compare_digest(expected_signature, req.razorpay_signature):
        # Update status to failed
        try:
            await db_agent.update_appointment_payment(
                appointment_id=req.appointment_id,
                payment_status="failed"
            )
        except Exception:
            pass
        raise HTTPException(status_code=400, detail="Invalid payment signature. Verification failed.")
        
    # Update status to paid
    try:
        updated_appt = await db_agent.update_appointment_payment(
            appointment_id=req.appointment_id,
            payment_status="paid",
            razorpay_payment_id=req.razorpay_payment_id,
            razorpay_signature=req.razorpay_signature
        )
        return {"success": True, "message": "Payment verified successfully", "appointment": updated_appt}
    except Exception as e:
        logger.error(f"Failed to update appointment payment status: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to complete payment transaction in database.")



# ---------------------------------------------------------------------------
# Auth / Profile Completion Endpoint (Google OAuth)
# ---------------------------------------------------------------------------

@app.post("/auth/complete-profile", tags=["Auth"])
async def complete_profile(req: CompleteProfileRequest, request: Request):
    """Complete a user's profile after Google OAuth sign-in (set role, insert into role table)."""
    user_info = get_user_info(request)
    user_id = user_info["user_id"]
    
    if not user_id or user_id == "default_user":
        raise HTTPException(status_code=401, detail="User is not authenticated.")
    
    if req.role not in ("lawyer", "client"):
        raise HTTPException(status_code=400, detail="Role must be 'lawyer' or 'client'.")
    
    db_agent = DBAgent()
    try:
        # Fetch user email from profiles
        loop = asyncio.get_running_loop()
        def _get_email():
            return db_agent.client.table("profiles").select("email").eq("id", user_id).single().execute()
        
        email_res = await loop.run_in_executor(None, _get_email)
        email = email_res.data.get("email", "") if email_res.data else ""
        
        profile = await db_agent.complete_profile(
            user_id=user_id,
            email=email,
            name=req.name,
            role=req.role
        )
        logger.info(f"✅ Profile completed for {user_id}: role={req.role}, name={req.name}")
        return {"success": True, "profile": profile}
    except Exception as e:
        logger.error(f"Failed to complete profile: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to complete profile: {str(e)}")


# ---------------------------------------------------------------------------
# Email Share Endpoint
# ---------------------------------------------------------------------------

class EmailShareRequest(BaseModel):
    recipient_email: str

def send_real_email(recipient_email: str, subject: str, body_text: str) -> bool:
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    
    smtp_host = os.getenv("SMTP_HOST")
    smtp_port = os.getenv("SMTP_PORT")
    smtp_user = os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASSWORD")
    smtp_sender = os.getenv("SMTP_SENDER", smtp_user or "noreply@lexiconai.com")
    
    if not smtp_host or not smtp_user or not smtp_password:
        logger.info("SMTP configuration missing in .env — skipping real email delivery.")
        return False
        
    try:
        port = int(smtp_port) if smtp_port else 587
        msg = MIMEMultipart()
        msg["From"] = smtp_sender
        msg["To"] = recipient_email
        msg["Subject"] = subject
        msg.attach(MIMEText(body_text, "plain", "utf-8"))
        
        server = smtplib.SMTP(smtp_host, port, timeout=10)
        server.starttls()
        server.login(smtp_user, smtp_password)
        server.sendmail(smtp_sender, [recipient_email], msg.as_string())
        server.quit()
        logger.info(f"📬 REAL SMTP EMAIL SENT to: {recipient_email}")
        return True
    except Exception as ex:
        logger.error(f"Failed to deliver SMTP email: {str(ex)}", exc_info=True)
        return False

@app.post("/share-email/{document_id}", dependencies=[Depends(verify_api_key)], tags=["Collaboration"])
async def share_analysis_email(document_id: str, req: EmailShareRequest, request: Request):
    """Generates and shares a summary brief, attempting real SMTP delivery, falling back to simulated logger."""
    user_info = get_user_info(request)
    
    await ensure_local_files(document_id)
    json_path = os.path.join(UPLOADS_DIR, f"{document_id}.json")
    if not os.path.exists(json_path):
        raise HTTPException(status_code=404, detail="Analysis results not found.")
        
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        summary = data.get("summary", {})
        risks = data.get("risks", [])
        metadata = data.get("metadata", {})
        risk_score = data.get("risk_score", 0.0)
        
        brief = (
            f"Dear Recipient,\n\n"
            f"Here is the Legal Document Analysis Brief shared by a Lexicon AI platform member.\n\n"
            f"--------------------------------------------------\n"
            f"DOCUMENT DETAILS\n"
            f"--------------------------------------------------\n"
            f"Document: {data.get('filename', 'Untitled PDF')}\n"
            f"Type: {metadata.get('document_type', 'Unknown')}\n"
            f"Parties: {', '.join(metadata.get('parties', ['Unknown']))}\n"
            f"Overall Risk Score: {risk_score}/10.0\n\n"
            f"--------------------------------------------------\n"
            f"EXECUTIVE SUMMARY\n"
            f"--------------------------------------------------\n"
            f"{summary.get('tldr', 'No summary available.')}\n\n"
            f"--------------------------------------------------\n"
            f"KEY FINDINGS & RISKS ({len(risks)} flag(s))\n"
            f"--------------------------------------------------\n"
        )
        
        for idx, risk in enumerate(risks[:5]):
            brief += f"{idx+1}. [{risk.get('severity', 'Medium')}] {risk.get('title', 'Risk')}: {risk.get('description', '')}\n"
            
        if len(risks) > 5:
            brief += f"...and {len(risks) - 5} more risks in the full report.\n"
            
        brief += (
            f"\n--------------------------------------------------\n"
            f"Please log in to your Lexicon AI portal to view the full interactive report, redline clauses, and chat with counsel.\n\n"
            f"Best regards,\n"
            f"Lexicon AI Systems"
        )
        
        # Deliver email
        email_subject = f"Legal Analysis Brief - {data.get('filename', 'Untitled PDF')}"
        sent_real = send_real_email(req.recipient_email, email_subject, brief)
        
        if not sent_real:
            logger.info(f"📧 SIMULATED EMAIL SENT to: {req.recipient_email}")
            logger.info(f"   Subject: {email_subject}")
            logger.info(f"   Sender: {user_info['user_id']} ({user_info['role']})")
            
        return {
            "success": True,
            "recipient": req.recipient_email,
            "brief": brief,
            "real_delivered": sent_real
        }
    except Exception as e:
        logger.error(f"Failed to export analysis by email: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to export email brief: {str(e)}")


# ---------------------------------------------------------------------------
# Contacts & Direct Messaging Endpoints
# ---------------------------------------------------------------------------

@app.get("/contacts", response_model=list[ContactResponse], dependencies=[Depends(verify_api_key)], tags=["Messaging"])
async def get_contacts(request: Request):
    """Get contacts for the current user based on appointment relationships."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.get_contacts(user_id=user_info["user_id"], role=user_info["role"])
    except Exception as e:
        logger.error(f"Failed to fetch contacts: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch contacts: {str(e)}")


@app.get("/direct-messages/{contact_id}", dependencies=[Depends(verify_api_key)], tags=["Messaging"])
async def get_direct_messages(contact_id: str, request: Request):
    """Get direct messages between the current user and a contact."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.get_direct_messages(user_id=user_info["user_id"], contact_id=contact_id)
    except Exception as e:
        logger.error(f"Failed to fetch direct messages: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch messages: {str(e)}")


@app.post("/direct-messages/{contact_id}", dependencies=[Depends(verify_api_key)], tags=["Messaging"])
async def send_direct_message(contact_id: str, req: DirectMessageCreate, request: Request):
    """Send a direct message to a contact."""
    user_info = get_user_info(request)
    display_name = request.headers.get("x-user-name", "User")
    db_agent = DBAgent()
    try:
        return await db_agent.send_direct_message(
            sender_id=user_info["user_id"],
            receiver_id=contact_id,
            sender_name=display_name,
            sender_role=user_info["role"],
            content=req.content
        )
    except Exception as e:
        logger.error(f"Failed to send direct message: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to send message: {str(e)}")
# ---------------------------------------------------------------------------
# Advanced Contract Intelligence Endpoints
# ---------------------------------------------------------------------------

@app.post("/compare/diff", response_model=SemanticDiffResponse, dependencies=[Depends(verify_api_key)], tags=["Analysis"])
async def compare_diff(req: CompareRequest):
    """Compares two contracts to generate a side-by-side semantic diff with risk level flags."""
    if len(req.document_ids) != 2:
        raise HTTPException(status_code=400, detail="Exactly two documents must be selected for comparison.")

    doc_a_id, doc_b_id = req.document_ids[0], req.document_ids[1]
    await ensure_local_files(doc_a_id)
    await ensure_local_files(doc_b_id)

    txt_a_path = os.path.join(UPLOADS_DIR, f"{doc_a_id}.txt")
    txt_b_path = os.path.join(UPLOADS_DIR, f"{doc_b_id}.txt")

    if not os.path.exists(txt_a_path) or not os.path.exists(txt_b_path):
        raise HTTPException(status_code=404, detail="One or both documents could not be found.")

    with open(txt_a_path, "r", encoding="utf-8") as f:
        text_a = f.read()
    with open(txt_b_path, "r", encoding="utf-8") as f:
        text_b = f.read()

    # Truncate text if too long to avoid token limits
    max_len = 12000
    if len(text_a) > max_len:
        text_a = text_a[:max_len]
    if len(text_b) > max_len:
        text_b = text_b[:max_len]

    system_prompt = (
        "You are an expert corporate legal counsel. Your task is to perform a semantic comparison "
        "between two versions of a contract (Version A and Version B) and identify clause-level differences. "
        "Map matched clauses/paragraphs and analyze how the terms evolved. "
        "Return a JSON object with this exact structure:\n\n"
        "{\n"
        '  "overall_change_summary": "High-level summary of the major changes.",\n'
        '  "risk_impact_summary": "Summary of how the overall risk profile has shifted.",\n'
        '  "diff_blocks": [\n'
        "    {\n"
        '      "title": "Title of the clause (e.g. Indemnification, Governing Law)",\n'
        '      "type": "added" | "removed" | "modified" | "unchanged",\n'
        '      "doc_a_text": "Exact wording of the clause in Version A (leave empty if added)",\n'
        '      "doc_b_text": "Exact wording of the clause in Version B (leave empty if removed)",\n'
        '      "change_explanation": "Explain what changed and why it matters legally.",\n'
        '      "risk_impact": "escalation" | "mitigation" | "neutral",\n'
        '      "severity": "High" | "Medium" | "Low" | "None"\n'
        "    }\n"
        "  ]\n"
        "}"
    )

    llm_client = LLMClient()
    try:
        raw_content = await llm_client.generate_response(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Version A:\n{text_a}\n\nVersion B:\n{text_b}"},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
        )
        return json.loads(raw_content)
    except Exception as e:
        logger.error(f"Semantic diff generation failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Semantic diff failed: {str(e)}")


@app.post("/deals", response_model=DealResponse, dependencies=[Depends(verify_api_key)], tags=["Deals"])
async def create_deal(req: DealCreate, request: Request):
    """Creates a new deal bundle grouping multiple documents."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        deal = await db_agent.create_deal_bundle(
            user_id=user_info["user_id"],
            name=req.name,
            description=req.description,
            document_ids=req.document_ids
        )
        return deal
    except Exception as e:
        logger.error(f"Failed to create deal bundle: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/deals", response_model=list[DealResponse], dependencies=[Depends(verify_api_key)], tags=["Deals"])
async def list_deals(request: Request):
    """Lists all deal bundles belonging to the active user."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        return await db_agent.list_deal_bundles(user_id=user_info["user_id"])
    except Exception as e:
        logger.error(f"Failed to list deal bundles: {e}", exc_info=True)
        return []


@app.get("/deals/{deal_id}", response_model=DealResponse, dependencies=[Depends(verify_api_key)], tags=["Deals"])
async def get_deal(deal_id: str):
    """Retrieves a single deal bundle by its ID."""
    db_agent = DBAgent()
    try:
        deal = await db_agent.get_deal_bundle(deal_id)
        if not deal:
            raise HTTPException(status_code=404, detail="Deal bundle not found.")
        return deal
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch deal bundle {deal_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/deals/{deal_id}", dependencies=[Depends(verify_api_key)], tags=["Deals"])
async def delete_deal(deal_id: str):
    """Deletes a deal bundle."""
    db_agent = DBAgent()
    try:
        success = await db_agent.delete_deal_bundle(deal_id)
        return {"success": success}
    except Exception as e:
        logger.error(f"Failed to delete deal bundle {deal_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/deals/{deal_id}/analyze", response_model=DealResponse, dependencies=[Depends(verify_api_key)], tags=["Deals"])
async def analyze_deal_bundle(deal_id: str):
    """Runs a multi-document correlation analysis across all contracts in the deal bundle."""
    db_agent = DBAgent()
    try:
        deal = await db_agent.get_deal_bundle(deal_id)
        if not deal:
            raise HTTPException(status_code=404, detail="Deal bundle not found.")

        doc_ids = deal.get("document_ids", [])
        if len(doc_ids) < 2:
            raise HTTPException(status_code=400, detail="A deal bundle must contain at least 2 documents to perform conflict analysis.")

        # Re-use existing compare logic
        comp_req = CompareRequest(document_ids=doc_ids)
        inconsistency_report = await compare_documents(comp_req)

        # Update report in database
        updated_deal = await db_agent.update_deal_bundle_report(deal_id, inconsistency_report)
        return updated_deal
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to analyze deal bundle {deal_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Deal bundle analysis failed: {str(e)}")


@app.post("/negotiate/chat", response_model=NegotiateChatResponse, dependencies=[Depends(verify_api_key)], tags=["Negotiation"])
async def negotiate_chat(req: NegotiateChatRequest):
    """Processes dialogue with the AI counterparty negotiator in the negotiation sandbox."""
    
    system_prompt = (
        f"You are the legal counsel for '{req.counterparty_name}' negotiating the '{req.clause_title}' clause "
        f"of a contract. The original clause wording is:\n"
        f"\"\"\"\n{req.clause_text}\n\"\"\"\n\n"
        f"Your negotiation personality is: '{req.personality_profile}'.\n"
        f"- 'Aggressive': Push hard for your company's interests, offer few compromises, and point out user weaknesses.\n"
        f"- 'Collaborative': Work with the user to find mutual win-win compromises and keep a friendly, constructive tone.\n"
        f"- 'Conservative': Focus heavily on risk aversion, boilerplate compliance, and slower approval steps.\n\n"
        f"Interact with the user's message/counter-proposal. Maintain role-play. "
        f"Return your final response ONLY as a JSON object with this exact structure:\n\n"
        "{\n"
        '  "reply": "Your message/dialogue response to the user.",\n'
        '  "agreement_percentage": integer,  # Progress percentage from 0 to 100\n'
        '  "counter_proposal": "Your suggested draft of the clause (or null if you accept user\'s proposal or at 100% agreement)",\n'
        '  "points_of_contention": ["list of remaining issues or clauses you want changed before signing off"]\n'
        "}"
    )

    messages = [{"role": "system", "content": system_prompt}]
    # Add dialog history
    for item in req.history:
        messages.append({"role": item.get("role", "user"), "content": item.get("content", "")})
    # Add user message
    messages.append({"role": "user", "content": req.user_message})

    llm_client = LLMClient()
    try:
        raw_content = await llm_client.generate_response(
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.4,
        )
        return json.loads(raw_content)
    except Exception as e:
        logger.error(f"Negotiation chat agent failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Negotiator failed: {str(e)}")


@app.get("/analytics/portfolio", response_model=PortfolioAnalyticsResponse, dependencies=[Depends(verify_api_key)], tags=["Analytics"])
async def get_portfolio_analytics(request: Request):
    """Computes aggregated portfolio-wide contract risk analytics and trends for the active user."""
    user_info = get_user_info(request)
    db_agent = DBAgent()
    try:
        analyses = []
        try:
            # Fetch list of analyses
            if user_info["role"] == "client":
                analyses = await db_agent.list_shared_analyses(client_id=user_info["user_id"])
            else:
                if user_info["user_id"] == "default_user":
                    raise ValueError("default_user requires local storage fallback")
                analyses = await db_agent.list_analyses(user_id=user_info["user_id"])
        except Exception as e:
            logger.warning(f"Database error in analytics: {e}. Falling back to local file storage scan.")
            analyses = []
            if os.path.exists(UPLOADS_DIR):
                for fname in os.listdir(UPLOADS_DIR):
                    if fname.endswith(".json") and fname != "deal_bundles.json":
                        doc_id = fname.replace(".json", "")
                        json_path = os.path.join(UPLOADS_DIR, fname)
                        try:
                            with open(json_path, "r", encoding="utf-8") as f:
                                data = json.load(f)
                            # Extract risk score synthetically if not present
                            score_val = 0.0
                            if "risk_score" in data:
                                score_val = float(data["risk_score"] or 0.0)
                            elif "risks" in data:
                                w = sum(r.get("severity_weight", 1) for r in data["risks"])
                                max_w = len(data["risks"]) * 3
                                score_val = round((w / max_w) * 10, 2) if max_w > 0 else 0.0
                                
                            analyses.append({
                                "document_id": doc_id,
                                "filename": data.get("filename") or (data.get("metadata", {}).get("document_type", "Unknown") + ".pdf"),
                                "document_type": data.get("metadata", {}).get("document_type", "Unknown"),
                                "risk_score": score_val,
                                "status": "completed",
                                "created_at": "2026-06-19T14:00:00Z"
                            })
                        except Exception:
                            pass

        total = len(analyses)
        if total == 0:
            return PortfolioAnalyticsResponse(
                total_contracts=0,
                avg_portfolio_risk=0.0,
                risk_distribution={"high": 0, "medium": 0, "low": 0},
                risk_category_radar={"Intellectual Property": 0, "Indemnification": 0, "Liability": 0, "Termination": 0, "Jurisdiction": 0},
                trends=[],
                counterparty_rankings=[]
            )

        # 1. Fetch full details for each analysis to inspect risks & metadata
        detailed_analyses = []
        for a in analyses:
            doc_id = a.get("document_id")
            json_path = os.path.join(UPLOADS_DIR, f"{doc_id}.json")
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        detailed_analyses.append(json.load(f))
                except Exception:
                    pass
        
        # If detail loading failed, fallback to summaries
        if not detailed_analyses:
            detailed_analyses = analyses

        # 2. Risk Distribution & Average
        risk_scores = [float(a.get("risk_score", 0.0) or 0.0) for a in analyses]
        avg_risk = round(sum(risk_scores) / len(risk_scores), 2)

        high_count = sum(1 for s in risk_scores if s >= 6.0)
        med_count = sum(1 for s in risk_scores if s >= 3.0 and s < 6.0)
        low_count = sum(1 for s in risk_scores if s < 3.0)

        # 3. Risk Categories (radar chart) using semantic keywords in risk titles
        category_scores = {"Intellectual Property": [], "Indemnification": [], "Liability": [], "Termination": [], "Jurisdiction": []}
        for det in detailed_analyses:
            for risk in det.get("risks", []):
                title = risk.get("title", "").lower()
                weight = risk.get("severity_weight", 1)
                
                matched = False
                if "ip" in title or "intellectual" in title or "copyright" in title or "patent" in title or "trademark" in title or "license" in title or "ownership" in title:
                    category_scores["Intellectual Property"].append(weight)
                    matched = True
                if "indemnity" in title or "indemnification" in title or "hold harmless" in title or "indemnify" in title:
                    category_scores["Indemnification"].append(weight)
                    matched = True
                if "liability" in title or "limitation" in title or "cap" in title or "damages" in title:
                    category_scores["Liability"].append(weight)
                    matched = True
                if "terminate" in title or "termination" in title or "cancel" in title or "renewal" in title or "duration" in title:
                    category_scores["Termination"].append(weight)
                    matched = True
                if "governing" in title or "jurisdiction" in title or "law" in title or "dispute" in title or "forum" in title:
                    category_scores["Jurisdiction"].append(weight)
                    matched = True
                
                # Default categorizations
                if not matched:
                    category_scores["Liability"].append(weight)

        # Compute average score per category (out of 10)
        radar_data = {}
        for cat, weights in category_scores.items():
            if weights:
                avg_w = sum(weights) / len(weights)
                radar_data[cat] = round(avg_w * 3.33, 2)
            else:
                radar_data[cat] = 0.0

        # 4. Trend Over Time (group by month from created_at)
        month_groups = defaultdict(list)
        for a in analyses:
            created_at = a.get("created_at") or ""
            month = created_at[:7] if len(created_at) >= 7 else "2026-06"
            month_groups[month].append(float(a.get("risk_score", 0.0) or 0.0))

        trends = []
        for m in sorted(month_groups.keys()):
            scores = month_groups[m]
            trends.append(AnalyticsTrendPoint(
                month=m,
                count=len(scores),
                avg_risk=round(sum(scores) / len(scores), 2)
            ))

        # 5. Counterparty Rankings
        counterparty_groups = defaultdict(list)
        for det in detailed_analyses:
            parties = det.get("metadata", {}).get("parties", [])
            risk_score = float(det.get("risk_score", 0.0) or 0.0)
            
            valid_parties = [p for p in parties if p.lower() not in ("user", "client", "lawyer", "unknown")]
            if not valid_parties:
                valid_parties = ["General Counterparties"]
                
            for p in valid_parties:
                counterparty_groups[p].append(risk_score)

        rankings = []
        for name, scores in counterparty_groups.items():
            rankings.append(CounterpartyRiskItem(
                name=name,
                contract_count=len(scores),
                avg_risk=round(sum(scores) / len(scores), 2)
            ))
        
        # Sort rankings by risk descending
        rankings.sort(key=lambda x: x.avg_risk, reverse=True)

        return PortfolioAnalyticsResponse(
            total_contracts=total,
            avg_portfolio_risk=avg_risk,
            risk_distribution=RiskSeverityDistribution(
                high=high_count,
                medium=med_count,
                low=low_count
            ),
            risk_category_radar=radar_data,
            trends=trends,
            counterparty_rankings=rankings[:10]
        )
    except Exception as e:
        logger.error(f"Failed to calculate portfolio analytics: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to load analytics: {str(e)}")
