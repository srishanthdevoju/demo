import os
import json
import time
import logging
import asyncio
from supabase import create_client, Client
from app.core.config import settings, dotenv_path

logger = logging.getLogger(__name__)

class MissingDBCredentialsError(ValueError):
    pass

class DatabaseExecutionError(RuntimeError):
    pass

class DBAgent:
    def __init__(self):
        self._client = None

    @property
    def client(self) -> Client:
        import os
        from dotenv import load_dotenv
        from app.core.config import dotenv_path
        load_dotenv(dotenv_path, override=True)

        supabase_url = os.getenv("SUPABASE_URL", settings.SUPABASE_URL)
        supabase_key = os.getenv("SUPABASE_KEY", settings.SUPABASE_KEY)

        if (
            not supabase_url
            or supabase_url.strip() == ""
            or not supabase_key
            or supabase_key.strip() == ""
        ):
            raise MissingDBCredentialsError("Supabase credentials (SUPABASE_URL and SUPABASE_KEY) are not configured in the environment.")
        
        if (
            self._client is None 
            or getattr(self, "_last_url", None) != supabase_url 
            or getattr(self, "_last_key", None) != supabase_key
        ):
            self._client = create_client(supabase_url, supabase_key)
            self._last_url = supabase_url
            self._last_key = supabase_key
            
        return self._client

    async def save_analysis(
        self,
        document_id: str,
        user_id: str,
        filename: str,
        summary: dict,
        risks: list,
        clauses: dict,
        metadata: dict,
        inconsistency_score: float = 0.0,
        inconsistencies: list = None,
        content_hash: str = None
    ) -> dict:
        """
        Inserts document analysis results into the Supabase 'analyses' table.
        Runs the synchronous database operations in an executor to avoid blocking the event loop.
        """
        try:
            supabase_client = self.client
        except MissingDBCredentialsError as e:
            raise e

        # Calculate a simple risk score from severity weights
        risk_score = 0.0
        if risks:
            total_weight = sum(r.get("severity_weight", 1) for r in risks)
            max_possible = len(risks) * 3  # max weight is 3 (High)
            risk_score = round((total_weight / max_possible) * 10, 2) if max_possible > 0 else 0.0

        # Extract document_type from metadata
        document_type = metadata.get("document_type", "Unknown")

        data = {
            "document_id": document_id,
            "user_id": user_id,
            "filename": filename,
            "document_type": document_type,
            "summary": summary,
            "risks": risks,
            "clauses": clauses,
            "metadata": metadata,
            "risk_score": risk_score,
            "inconsistency_score": inconsistency_score,
            "inconsistencies": inconsistencies or [],
            "status": "completed",
            "notes": content_hash or "",
            "review_status": "pending",
            "lawyer_notes": "",
            "collaboration_messages": []
        }

        def _execute_insert():
            return supabase_client.table("analyses").insert(data).execute()

        try:
            logger.info(f"Saving analysis for document ID {document_id} to table 'analyses'")
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, _execute_insert)
            return response.data
        except Exception as e:
            logger.error(f"Failed to insert analysis records into Supabase: {str(e)}", exc_info=True)
            raise DatabaseExecutionError(f"Database insertion failed: {str(e)}")

    async def find_analysis_by_hash(self, content_hash: str, user_id: str) -> dict:
        """
        Finds an existing analysis by its content hash for the same user.
        Used to return cached results for identical document uploads.
        """
        try:
            supabase_client = self.client
        except MissingDBCredentialsError:
            return None

        def _execute():
            return supabase_client.table("analyses").select("*").eq(
                "notes", content_hash
            ).eq("user_id", user_id).limit(1).execute()

        try:
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, _execute)
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            logger.error(f"Failed to find analysis by hash: {str(e)}")
            return None

    async def list_analyses(self, user_id: str = None, limit: int = 50) -> list:
        """
        Lists recent analyses from Supabase, optionally filtered by user_id.
        Returns a list of analysis summary records.
        """
        try:
            supabase_client = self.client
        except MissingDBCredentialsError:
            raise

        def _execute_query():
            query = supabase_client.table("analyses").select(
                "document_id, filename, document_type, risk_score, status, created_at, user_id"
            ).order("created_at", desc=True).limit(limit)

            if user_id:
                query = query.eq("user_id", user_id)

            return query.execute()

        try:
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, _execute_query)
            return response.data or []
        except Exception as e:
            logger.error(f"Failed to list analyses from Supabase: {str(e)}", exc_info=True)
            raise DatabaseExecutionError(f"Database query failed: {str(e)}")

    async def get_analysis(self, document_id: str) -> dict:
        """
        Fetches a single analysis record from Supabase by document_id.
        """
        try:
            supabase_client = self.client
        except MissingDBCredentialsError:
            raise

        def _execute_query():
            return supabase_client.table("analyses").select("*").eq(
                "document_id", document_id
            ).single().execute()

        try:
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, _execute_query)
            return response.data
        except Exception as e:
            logger.error(f"Failed to get analysis {document_id}: {str(e)}", exc_info=True)
            raise DatabaseExecutionError(f"Database query failed: {str(e)}")

    # --- Notes Methods ---

    async def save_note(self, document_id: str, user_id: str, content: str) -> dict:
        """Creates a new note."""
        supabase_client = self.client
        
        # Clean document_id
        doc_id = None
        if document_id and str(document_id).strip().lower() not in ("none", "null", ""):
            doc_id = document_id
            
        data = {
            "document_id": doc_id,
            "user_id": user_id,
            "content": content
        }
        def _execute():
            return supabase_client.table("notes").insert(data).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    async def get_notes(self, document_id: str, user_id: str = None) -> list:
        """Fetches notes for a specific document, optionally filtered by user_id."""
        supabase_client = self.client
        def _execute():
            query = supabase_client.table("notes").select("*").eq("document_id", document_id)
            if user_id:
                query = query.eq("user_id", user_id)
            return query.order("created_at", desc=True).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    async def update_note(self, note_id: int, user_id: str, content: str) -> dict:
        """Updates an existing note."""
        supabase_client = self.client
        def _execute():
            return supabase_client.table("notes").update({
                "content": content,
                "updated_at": "now()"
            }).eq("id", note_id).eq("user_id", user_id).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    async def delete_note(self, note_id: int, user_id: str) -> bool:
        """Deletes a note."""
        supabase_client = self.client
        def _execute():
            return supabase_client.table("notes").delete().eq("id", note_id).eq("user_id", user_id).execute()
        
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _execute)
        return True

    async def list_all_notes(self, user_id: str) -> list:
        """Lists all notes for a user across all documents, joining with analyses to get the filename."""
        supabase_client = self.client
        def _execute():
            # In Supabase JS, this would be select("*, analyses(filename)"), but in Python, the syntax is similar
            return supabase_client.table("notes").select("*, analyses(filename)").eq("user_id", user_id).order("created_at", desc=True).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    async def get_notes_count_map(self, user_id: str = None) -> dict:
        """Returns a mapping of document_id -> notes_count for a user."""
        supabase_client = self.client
        def _execute():
            query = supabase_client.table("notes").select("document_id")
            if user_id:
                query = query.eq("user_id", user_id)
            return query.execute()
        
        try:
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, _execute)
            counts = {}
            for item in (response.data or []):
                doc_id = item["document_id"]
                counts[doc_id] = counts.get(doc_id, 0) + 1
            return counts
        except Exception:
            return {}

    # --- Messaging Methods ---

    async def send_message(self, document_id: str, sender_id: str, sender_role: str, sender_name: str, content: str) -> dict:
        """Sends a message in the document's collaboration thread."""
        supabase_client = self.client
        data = {
            "document_id": document_id,
            "sender_id": sender_id,
            "sender_role": sender_role,
            "sender_name": sender_name,
            "content": content
        }
        def _execute():
            return supabase_client.table("messages").insert(data).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    async def get_messages(self, document_id: str) -> list:
        """Fetches messages for a document in chronological order."""
        supabase_client = self.client
        def _execute():
            return supabase_client.table("messages").select("*").eq("document_id", document_id).order("created_at", desc=False).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    # --- Document Sharing Methods ---

    async def share_document(self, document_id: str, lawyer_id: str, client_email: str) -> dict:
        """Shares a document with a client using their email."""
        supabase_client = self.client
        
        def _find_client():
            return supabase_client.table("profiles").select("id").eq("email", client_email).execute()
            
        loop = asyncio.get_running_loop()
        client_res = await loop.run_in_executor(None, _find_client)
        if not client_res.data:
            raise ValueError(f"No user found with email {client_email}. The client must register first.")
            
        client_id = client_res.data[0]["id"]
        
        data = {
            "document_id": document_id,
            "lawyer_id": lawyer_id,
            "client_id": client_id
        }
        
        def _execute_share():
            return supabase_client.table("shared_documents").insert(data).execute()
            
        response = await loop.run_in_executor(None, _execute_share)
        return response.data[0] if response.data else {}

    async def list_shared_analyses(self, client_id: str) -> list:
        """Lists all document analyses shared with or uploaded by a specific client."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()
        
        # 1. Fetch documents shared with the client
        def _execute_shared():
            return supabase_client.table("shared_documents").select("*, analyses(*)").eq("client_id", client_id).execute()
        
        # 2. Fetch documents uploaded by the client directly
        def _execute_uploaded():
            return supabase_client.table("analyses").select("*").eq("user_id", client_id).execute()
            
        res_shared, res_uploaded = await asyncio.gather(
            loop.run_in_executor(None, _execute_shared),
            loop.run_in_executor(None, _execute_uploaded)
        )
        
        # Combine them
        combined = {}
        for item in (res_shared.data or []):
            if item.get("analyses"):
                analysis = item["analyses"]
                combined[analysis["document_id"]] = analysis
                
        for analysis in (res_uploaded.data or []):
            combined[analysis["document_id"]] = analysis
            
        # Convert to list and sort by created_at descending
        results = list(combined.values())
        results.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return results
    async def get_lawyers(self) -> list:
        """Fetches all registered lawyers from public.lawyers."""
        supabase_client = self.client
        def _execute():
            return supabase_client.table("lawyers").select("*").order("name", desc=False).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    # --- Auto-assignment Logic ---

    async def get_least_busy_lawyer(self) -> dict:
        """
        Finds the lawyer with the fewest upcoming scheduled appointments.
        Used for auto-assignment when client doesn't choose a specific lawyer.
        Returns the lawyer record or None if no lawyers exist.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        # 1. Get all lawyers
        def _get_all_lawyers():
            return supabase_client.table("lawyers").select("id, name, email, specialty").order("name", desc=False).execute()

        lawyers_res = await loop.run_in_executor(None, _get_all_lawyers)
        all_lawyers = lawyers_res.data or []

        if not all_lawyers:
            return None

        # 2. Count upcoming scheduled appointments per lawyer
        from datetime import date as date_type
        today_str = date_type.today().isoformat()

        def _get_upcoming_appointments():
            return supabase_client.table("appointments").select("lawyer_id").eq("status", "scheduled").gte("appointment_date", today_str).execute()

        appts_res = await loop.run_in_executor(None, _get_upcoming_appointments)
        upcoming = appts_res.data or []

        # Build count map
        appt_counts = {}
        for appt in upcoming:
            lid = appt.get("lawyer_id")
            if lid:
                appt_counts[lid] = appt_counts.get(lid, 0) + 1

        # 3. Find lawyer with fewest upcoming appointments
        best_lawyer = None
        min_count = float("inf")
        for lawyer in all_lawyers:
            count = appt_counts.get(lawyer["id"], 0)
            if count < min_count:
                min_count = count
                best_lawyer = lawyer

        return best_lawyer

    async def create_appointment(self, client_id: str, lawyer_id: str, client_name: str, lawyer_name: str, title: str, description: str, date: str, time: str, share_phone_with_lawyer: bool = False) -> dict:
        """Creates a new scheduled consultation in the appointments table."""
        supabase_client = self.client
        data = {
            "client_id": client_id,
            "lawyer_id": lawyer_id,
            "title": title,
            "description": description,
            "appointment_date": date,
            "appointment_time": time,
            "status": "scheduled",
            "share_phone_with_lawyer": share_phone_with_lawyer,
            "payment_status": "unpaid",
            "consultation_fee": 500.00
        }
        def _execute():
            return supabase_client.table("appointments").insert(data).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        res_data = response.data[0] if response.data else {}
        if res_data:
            res_data["client_name"] = client_name
            res_data["lawyer_name"] = lawyer_name
        return res_data

    async def get_appointments(self, user_id: str, role: str) -> list:
        """Fetches appointments for the user, including related client/lawyer names and phone numbers."""
        supabase_client = self.client
        def _execute():
            query = supabase_client.table("appointments").select("*")
            if role == "client":
                query = query.eq("client_id", user_id)
            else:
                query = query.eq("lawyer_id", user_id)
            return query.order("appointment_date", desc=False).order("appointment_time", desc=False).execute()
        
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, _execute)
        appointments = res.data or []
        
        if not appointments:
            return []
            
        # Enrich appointments with names from profiles
        user_ids = set()
        for appt in appointments:
            user_ids.add(appt["client_id"])
            if appt.get("lawyer_id"):
                user_ids.add(appt["lawyer_id"])
            
        if user_ids:
            def _fetch_profiles():
                return supabase_client.table("profiles").select("id, name, phone").in_("id", list(user_ids)).execute()
            
            profiles_res = await loop.run_in_executor(None, _fetch_profiles)
            profile_map = {p["id"]: p for p in (profiles_res.data or [])}
            
            for appt in appointments:
                client_id = appt["client_id"]
                lawyer_id = appt.get("lawyer_id")
                
                appt["client_name"] = profile_map.get(client_id, {}).get("name", "Unknown Client")
                appt["lawyer_name"] = profile_map.get(lawyer_id, {}).get("name", "Unknown Lawyer")
                
                # Check status and role visibility
                is_active = appt["status"] in ("accepted", "completed")
                
                # Always hide by default
                appt["client_phone"] = None
                appt["lawyer_phone"] = None
                
                if is_active:
                    # Client can see lawyer's phone number
                    if lawyer_id and lawyer_id in profile_map:
                        appt["lawyer_phone"] = profile_map[lawyer_id].get("phone")
                    
                    # Lawyer can see client's phone number only if share_phone_with_lawyer is True
                    if appt.get("share_phone_with_lawyer"):
                        appt["client_phone"] = profile_map.get(client_id, {}).get("phone")
                
        return appointments

    async def update_appointment(self, appointment_id: int, status: str) -> dict:
        """Updates the status of an appointment. Generates a meeting link when accepted."""
        supabase_client = self.client
        
        update_data = {"status": status}
        
        # Generate a deterministic meeting link when accepting
        if status == "accepted":
            meeting_link = f"https://meet.jit.si/lexicon-meeting-{appointment_id}"
            update_data["meeting_link"] = meeting_link
        
        def _execute():
            return supabase_client.table("appointments").update(update_data).eq("id", appointment_id).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    async def update_appointment_payment(self, appointment_id: int, payment_status: str, razorpay_payment_id: str = None, razorpay_signature: str = None, razorpay_order_id: str = None) -> dict:
        """Updates the payment details of an appointment."""
        supabase_client = self.client
        update_data = {
            "payment_status": payment_status
        }
        if razorpay_payment_id:
            update_data["razorpay_payment_id"] = razorpay_payment_id
        if razorpay_signature:
            update_data["razorpay_signature"] = razorpay_signature
        if razorpay_order_id:
            update_data["razorpay_order_id"] = razorpay_order_id

        def _execute():
            return supabase_client.table("appointments").update(update_data).eq("id", appointment_id).execute()

        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    # --- Profile Completion (Google OAuth) ---

    async def complete_profile(self, user_id: str, email: str, name: str, role: str) -> dict:
        """
        Completes a user's profile after Google OAuth.
        Updates the profiles table role and inserts into lawyers/clients table.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        # 1. Update the profile role and name
        def _update_profile():
            return supabase_client.table("profiles").update({
                "role": role,
                "name": name
            }).eq("id", user_id).execute()

        await loop.run_in_executor(None, _update_profile)

        # 2. Insert into the appropriate role table
        if role == "lawyer":
            def _insert_lawyer():
                return supabase_client.table("lawyers").upsert({
                    "id": user_id,
                    "name": name,
                    "email": email,
                    "specialty": "General Counsel"
                }).execute()

            await loop.run_in_executor(None, _insert_lawyer)
        elif role == "client":
            def _insert_client():
                return supabase_client.table("clients").upsert({
                    "id": user_id,
                    "name": name,
                    "email": email
                }).execute()

            await loop.run_in_executor(None, _insert_client)

        # 3. Return the updated profile
        def _get_profile():
            return supabase_client.table("profiles").select("*").eq("id", user_id).single().execute()

        result = await loop.run_in_executor(None, _get_profile)
        return result.data or {}

    # --- Contacts & Direct Messaging ---

    async def get_contacts(self, user_id: str, role: str) -> list:
        """
        Gets contacts for a user based on accepted/completed appointments.
        Clients see their connected lawyers; lawyers see their connected clients.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        def _get_appointments():
            query = supabase_client.table("appointments").select("client_id, lawyer_id, share_phone_with_lawyer")
            if role == "client":
                query = query.eq("client_id", user_id)
            else:
                query = query.eq("lawyer_id", user_id)
            return query.in_("status", ["accepted", "completed"]).execute()

        appts_res = await loop.run_in_executor(None, _get_appointments)
        appointments = appts_res.data or []

        if not appointments:
            return []

        # Collect unique contact IDs (the other party) and phone visibility permissions
        contact_ids = set()
        share_allowed_contacts = set()
        for appt in appointments:
            if role == "client":
                if appt.get("lawyer_id"):
                    contact_ids.add(appt["lawyer_id"])
                    share_allowed_contacts.add(appt["lawyer_id"]) # Always see lawyer phone if accepted
            else:
                contact_ids.add(appt["client_id"])
                if appt.get("share_phone_with_lawyer"):
                    share_allowed_contacts.add(appt["client_id"]) # See client phone if shared

        if not contact_ids:
            return []

        # Fetch profile details for contacts
        def _get_profiles():
            return supabase_client.table("profiles").select("id, name, email, role, phone").in_("id", list(contact_ids)).execute()

        profiles_res = await loop.run_in_executor(None, _get_profiles)
        contacts = []
        for p in (profiles_res.data or []):
            contact = {
                "id": p["id"],
                "name": p["name"],
                "email": p["email"],
                "role": p["role"],
                "phone": p.get("phone") if p["id"] in share_allowed_contacts else None,
                "specialty": None
            }
            # Add specialty for lawyers
            if p["role"] == "lawyer":
                def _get_lawyer_info(lid=p["id"]):
                    return supabase_client.table("lawyers").select("specialty").eq("id", lid).execute()
                try:
                    lawyer_res = await loop.run_in_executor(None, _get_lawyer_info)
                    if lawyer_res.data:
                        contact["specialty"] = lawyer_res.data[0].get("specialty")
                except Exception:
                    pass
            contacts.append(contact)

        return contacts

    async def get_direct_messages(self, user_id: str, contact_id: str) -> list:
        """Fetches direct messages between two users."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        def _execute():
            # Get messages where either user is sender and other is receiver
            return supabase_client.table("direct_messages").select("*").or_(
                f"and(sender_id.eq.{user_id},receiver_id.eq.{contact_id}),and(sender_id.eq.{contact_id},receiver_id.eq.{user_id})"
            ).order("created_at", desc=False).execute()

        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    async def send_direct_message(self, sender_id: str, receiver_id: str, sender_name: str, sender_role: str, content: str) -> dict:
        """Sends a direct message between two users."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        data = {
            "sender_id": sender_id,
            "receiver_id": receiver_id,
            "sender_name": sender_name,
            "sender_role": sender_role,
            "content": content
        }

        def _execute():
            return supabase_client.table("direct_messages").insert(data).execute()

        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    # --- Profile Phone & Availability Slot updates ---

    async def update_profile_phone(self, user_id: str, role: str, phone: str) -> dict:
        """Updates the phone number in profiles and role-specific tables."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()
        
        # Update profiles table
        def _update_p():
            return supabase_client.table("profiles").update({"phone": phone}).eq("id", user_id).execute()
        await loop.run_in_executor(None, _update_p)
        
        # Update role-specific table
        if role == "lawyer":
            def _update_l():
                return supabase_client.table("lawyers").update({"phone": phone}).eq("id", user_id).execute()
            await loop.run_in_executor(None, _update_l)
        elif role == "client":
            def _update_c():
                return supabase_client.table("clients").update({"phone": phone}).eq("id", user_id).execute()
            await loop.run_in_executor(None, _update_c)
            
        return {"success": True, "phone": phone}

    async def update_lawyer_slots(self, lawyer_id: str, slots: str) -> dict:
        """Updates availability slots for a lawyer."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()
        def _execute():
            return supabase_client.table("lawyers").update({"available_slots": slots}).eq("id", lawyer_id).execute()
        res = await loop.run_in_executor(None, _execute)
        return res.data[0] if res.data else {}


    # --- Deal Bundle Methods ---

    async def create_deal_bundle(self, user_id: str, name: str, description: str, document_ids: list) -> dict:
        """Creates a new deal bundle. Falls back to local json file if database is not configured."""
        try:
            supabase_client = self.client
            data = {
                "user_id": user_id,
                "name": name,
                "description": description,
                "document_ids": document_ids,
                "inconsistency_report": {}
            }
            def _execute():
                return supabase_client.table("deal_bundles").insert(data).execute()
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, _execute)
            return res.data[0] if res.data else {}
        except (MissingDBCredentialsError, Exception) as e:
            logger.warning(f"Database error while creating deal bundle: {e}. Falling back to local storage.")
            import uuid
            uploads_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
            local_deals_path = os.path.join(uploads_dir, "deal_bundles.json")
            deals = []
            if os.path.exists(local_deals_path):
                try:
                    with open(local_deals_path, "r", encoding="utf-8") as f:
                        deals = json.load(f)
                except Exception:
                    pass
            new_deal = {
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "name": name,
                "description": description,
                "document_ids": document_ids,
                "inconsistency_report": {},
                "created_at": "now"
            }
            deals.append(new_deal)
            with open(local_deals_path, "w", encoding="utf-8") as f:
                json.dump(deals, f, indent=2)
            return new_deal

    async def list_deal_bundles(self, user_id: str) -> list:
        """Lists all deal bundles for a user."""
        try:
            supabase_client = self.client
            def _execute():
                return supabase_client.table("deal_bundles").select("*").eq("user_id", user_id).order("created_at", desc=True).execute()
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, _execute)
            return res.data or []
        except (MissingDBCredentialsError, Exception) as e:
            logger.warning(f"Database error while listing deal bundles: {e}. Falling back to local storage.")
            uploads_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
            local_deals_path = os.path.join(uploads_dir, "deal_bundles.json")
            if os.path.exists(local_deals_path):
                try:
                    with open(local_deals_path, "r", encoding="utf-8") as f:
                        deals = json.load(f)
                    return [d for d in deals if d.get("user_id") == user_id]
                except Exception:
                    pass
            return []

    async def get_deal_bundle(self, deal_id: str) -> dict:
        """Retrieves a single deal bundle."""
        try:
            supabase_client = self.client
            def _execute():
                return supabase_client.table("deal_bundles").select("*").eq("id", deal_id).single().execute()
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, _execute)
            return res.data
        except (MissingDBCredentialsError, Exception) as e:
            logger.warning(f"Database error while getting deal bundle: {e}. Falling back to local storage.")
            uploads_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
            local_deals_path = os.path.join(uploads_dir, "deal_bundles.json")
            if os.path.exists(local_deals_path):
                try:
                    with open(local_deals_path, "r", encoding="utf-8") as f:
                        deals = json.load(f)
                    for d in deals:
                        if d.get("id") == deal_id:
                            return d
                except Exception:
                    pass
            return None

    async def update_deal_bundle_report(self, deal_id: str, report: dict) -> dict:
        """Updates the inconsistency report of a deal bundle."""
        try:
            supabase_client = self.client
            def _execute():
                return supabase_client.table("deal_bundles").update({"inconsistency_report": report}).eq("id", deal_id).execute()
            loop = asyncio.get_running_loop()
            res = await loop.run_in_executor(None, _execute)
            return res.data[0] if res.data else {}
        except (MissingDBCredentialsError, Exception) as e:
            logger.warning(f"Database error while updating deal bundle report: {e}. Falling back to local storage.")
            uploads_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
            local_deals_path = os.path.join(uploads_dir, "deal_bundles.json")
            if os.path.exists(local_deals_path):
                try:
                    with open(local_deals_path, "r", encoding="utf-8") as f:
                        deals = json.load(f)
                    for d in deals:
                        if d.get("id") == deal_id:
                            d["inconsistency_report"] = report
                            break
                    with open(local_deals_path, "w", encoding="utf-8") as f:
                        json.dump(deals, f, indent=2)
                    return {"id": deal_id, "inconsistency_report": report}
                except Exception:
                    pass
            return {}

    async def delete_deal_bundle(self, deal_id: str) -> bool:
        """Deletes a deal bundle."""
        try:
            supabase_client = self.client
            def _execute():
                return supabase_client.table("deal_bundles").delete().eq("id", deal_id).execute()
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _execute)
            return True
        except (MissingDBCredentialsError, Exception) as e:
            logger.warning(f"Database error while deleting deal bundle: {e}. Falling back to local storage.")
            uploads_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
            local_deals_path = os.path.join(uploads_dir, "deal_bundles.json")
            if os.path.exists(local_deals_path):
                try:
                    with open(local_deals_path, "r", encoding="utf-8") as f:
                        deals = json.load(f)
                    deals = [d for d in deals if d.get("id") != deal_id]
                    with open(local_deals_path, "w", encoding="utf-8") as f:
                        json.dump(deals, f, indent=2)
                    return True
                except Exception:
                    pass
            return False

    async def get_lawyers(self) -> list:
        """Fetches all registered lawyers from public.lawyers."""
        supabase_client = self.client
        def _execute():
            return supabase_client.table("lawyers").select("*").order("name", desc=False).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    # --- Auto-assignment Logic ---

    async def get_least_busy_lawyer(self) -> dict:
        """
        Finds the lawyer with the fewest upcoming scheduled appointments.
        Used for auto-assignment when client doesn't choose a specific lawyer.
        Returns the lawyer record or None if no lawyers exist.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        # 1. Get all lawyers
        def _get_all_lawyers():
            return supabase_client.table("lawyers").select("id, name, email, specialty").order("name", desc=False).execute()

        lawyers_res = await loop.run_in_executor(None, _get_all_lawyers)
        all_lawyers = lawyers_res.data or []

        if not all_lawyers:
            return None

        # 2. Count upcoming scheduled appointments per lawyer
        from datetime import date as date_type
        today_str = date_type.today().isoformat()

        def _get_upcoming_appointments():
            return supabase_client.table("appointments").select("lawyer_id").eq("status", "scheduled").gte("appointment_date", today_str).execute()

        appts_res = await loop.run_in_executor(None, _get_upcoming_appointments)
        upcoming = appts_res.data or []

        # Build count map
        appt_counts = {}
        for appt in upcoming:
            lid = appt.get("lawyer_id")
            if lid:
                appt_counts[lid] = appt_counts.get(lid, 0) + 1

        # 3. Find lawyer with fewest upcoming appointments
        best_lawyer = None
        min_count = float("inf")
        for lawyer in all_lawyers:
            count = appt_counts.get(lawyer["id"], 0)
            if count < min_count:
                min_count = count
                best_lawyer = lawyer

        return best_lawyer

    async def create_appointment(self, client_id: str, lawyer_id: str, client_name: str, lawyer_name: str, title: str, description: str, date: str, time: str, share_phone_with_lawyer: bool = False) -> dict:
        """Creates a new scheduled consultation in the appointments table."""
        supabase_client = self.client
        data = {
            "client_id": client_id,
            "lawyer_id": lawyer_id,
            "title": title,
            "description": description,
            "appointment_date": date,
            "appointment_time": time,
            "status": "scheduled",
            "share_phone_with_lawyer": share_phone_with_lawyer
        }
        def _execute():
            return supabase_client.table("appointments").insert(data).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        res_data = response.data[0] if response.data else {}
        if res_data:
            res_data["client_name"] = client_name
            res_data["lawyer_name"] = lawyer_name
        return res_data

    async def get_appointments(self, user_id: str, role: str) -> list:
        """Fetches appointments for the user, including related client/lawyer names and phone numbers."""
        supabase_client = self.client
        def _execute():
            query = supabase_client.table("appointments").select("*")
            if role == "client":
                query = query.eq("client_id", user_id)
            else:
                query = query.eq("lawyer_id", user_id)
            return query.order("appointment_date", desc=False).order("appointment_time", desc=False).execute()
        
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, _execute)
        appointments = res.data or []
        
        if not appointments:
            return []
            
        # Enrich appointments with names from profiles
        user_ids = set()
        for appt in appointments:
            user_ids.add(appt["client_id"])
            if appt.get("lawyer_id"):
                user_ids.add(appt["lawyer_id"])
            
        if user_ids:
            def _fetch_profiles():
                return supabase_client.table("profiles").select("id, name, phone").in_("id", list(user_ids)).execute()
            
            profiles_res = await loop.run_in_executor(None, _fetch_profiles)
            profile_map = {p["id"]: p for p in (profiles_res.data or [])}
            
            for appt in appointments:
                client_id = appt["client_id"]
                lawyer_id = appt.get("lawyer_id")
                
                appt["client_name"] = profile_map.get(client_id, {}).get("name", "Unknown Client")
                appt["lawyer_name"] = profile_map.get(lawyer_id, {}).get("name", "Unknown Lawyer")
                
                # Check status and role visibility
                is_active = appt["status"] in ("accepted", "completed")
                
                # Always hide by default
                appt["client_phone"] = None
                appt["lawyer_phone"] = None
                
                if is_active:
                    # Client can see lawyer's phone number
                    if lawyer_id and lawyer_id in profile_map:
                        appt["lawyer_phone"] = profile_map[lawyer_id].get("phone")
                    
                    # Lawyer can see client's phone number only if share_phone_with_lawyer is True
                    if appt.get("share_phone_with_lawyer"):
                        appt["client_phone"] = profile_map.get(client_id, {}).get("phone")
                
        return appointments

    async def update_appointment(self, appointment_id: int, status: str) -> dict:
        """Updates the status of an appointment. Generates a meeting link when accepted."""
        supabase_client = self.client
        
        update_data = {"status": status}
        
        # Generate a deterministic meeting link when accepting
        if status == "accepted":
            meeting_link = f"https://meet.jit.si/lexicon-meeting-{appointment_id}"
            update_data["meeting_link"] = meeting_link
        
        def _execute():
            return supabase_client.table("appointments").update(update_data).eq("id", appointment_id).execute()
        
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    # --- Profile Completion (Google OAuth) ---

    async def complete_profile(self, user_id: str, email: str, name: str, role: str) -> dict:
        """
        Completes a user's profile after Google OAuth.
        Updates the profiles table role and inserts into lawyers/clients table.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        # 1. Update the profile role and name
        def _update_profile():
            return supabase_client.table("profiles").update({
                "role": role,
                "name": name
            }).eq("id", user_id).execute()

        await loop.run_in_executor(None, _update_profile)

        # 2. Insert into the appropriate role table
        if role == "lawyer":
            def _insert_lawyer():
                return supabase_client.table("lawyers").upsert({
                    "id": user_id,
                    "name": name,
                    "email": email,
                    "specialty": "General Counsel"
                }).execute()

            await loop.run_in_executor(None, _insert_lawyer)
        elif role == "client":
            def _insert_client():
                return supabase_client.table("clients").upsert({
                    "id": user_id,
                    "name": name,
                    "email": email
                }).execute()

            await loop.run_in_executor(None, _insert_client)

        # 3. Return the updated profile
        def _get_profile():
            return supabase_client.table("profiles").select("*").eq("id", user_id).single().execute()

        result = await loop.run_in_executor(None, _get_profile)
        return result.data or {}

    # --- Contacts & Direct Messaging ---

    async def get_contacts(self, user_id: str, role: str) -> list:
        """
        Gets contacts for a user based on accepted/completed appointments.
        Clients see their connected lawyers; lawyers see their connected clients.
        """
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        def _get_appointments():
            query = supabase_client.table("appointments").select("client_id, lawyer_id, share_phone_with_lawyer")
            if role == "client":
                query = query.eq("client_id", user_id)
            else:
                query = query.eq("lawyer_id", user_id)
            return query.in_("status", ["accepted", "completed"]).execute()

        appts_res = await loop.run_in_executor(None, _get_appointments)
        appointments = appts_res.data or []

        if not appointments:
            return []

        # Collect unique contact IDs (the other party) and phone visibility permissions
        contact_ids = set()
        share_allowed_contacts = set()
        for appt in appointments:
            if role == "client":
                if appt.get("lawyer_id"):
                    contact_ids.add(appt["lawyer_id"])
                    share_allowed_contacts.add(appt["lawyer_id"]) # Always see lawyer phone if accepted
            else:
                contact_ids.add(appt["client_id"])
                if appt.get("share_phone_with_lawyer"):
                    share_allowed_contacts.add(appt["client_id"]) # See client phone if shared

        if not contact_ids:
            return []

        # Fetch profile details for contacts
        def _get_profiles():
            return supabase_client.table("profiles").select("id, name, email, role, phone").in_("id", list(contact_ids)).execute()

        profiles_res = await loop.run_in_executor(None, _get_profiles)
        contacts = []
        for p in (profiles_res.data or []):
            contact = {
                "id": p["id"],
                "name": p["name"],
                "email": p["email"],
                "role": p["role"],
                "phone": p.get("phone") if p["id"] in share_allowed_contacts else None,
                "specialty": None
            }
            # Add specialty for lawyers
            if p["role"] == "lawyer":
                def _get_lawyer_info(lid=p["id"]):
                    return supabase_client.table("lawyers").select("specialty").eq("id", lid).execute()
                try:
                    lawyer_res = await loop.run_in_executor(None, _get_lawyer_info)
                    if lawyer_res.data:
                        contact["specialty"] = lawyer_res.data[0].get("specialty")
                except Exception:
                    pass
            contacts.append(contact)

        return contacts

    async def get_direct_messages(self, user_id: str, contact_id: str) -> list:
        """Fetches direct messages between two users."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        def _execute():
            # Get messages where either user is sender and other is receiver
            return supabase_client.table("direct_messages").select("*").or_(
                f"and(sender_id.eq.{user_id},receiver_id.eq.{contact_id}),and(sender_id.eq.{contact_id},receiver_id.eq.{user_id})"
            ).order("created_at", desc=False).execute()

        response = await loop.run_in_executor(None, _execute)
        return response.data or []

    async def send_direct_message(self, sender_id: str, receiver_id: str, sender_name: str, sender_role: str, content: str) -> dict:
        """Sends a direct message between two users."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()

        data = {
            "sender_id": sender_id,
            "receiver_id": receiver_id,
            "sender_name": sender_name,
            "sender_role": sender_role,
            "content": content
        }

        def _execute():
            return supabase_client.table("direct_messages").insert(data).execute()

        response = await loop.run_in_executor(None, _execute)
        return response.data[0] if response.data else {}

    # --- Profile Phone & Availability Slot updates ---

    async def update_profile_phone(self, user_id: str, role: str, phone: str) -> dict:
        """Updates the phone number in profiles and role-specific tables."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()
        
        # Update profiles table
        def _update_p():
            return supabase_client.table("profiles").update({"phone": phone}).eq("id", user_id).execute()
        await loop.run_in_executor(None, _update_p)
        
        # Update role-specific table
        if role == "lawyer":
            def _update_l():
                return supabase_client.table("lawyers").update({"phone": phone}).eq("id", user_id).execute()
            await loop.run_in_executor(None, _update_l)
        elif role == "client":
            def _update_c():
                return supabase_client.table("clients").update({"phone": phone}).eq("id", user_id).execute()
            await loop.run_in_executor(None, _update_c)
            
        return {"success": True, "phone": phone}

    async def update_lawyer_slots(self, lawyer_id: str, slots: str) -> dict:
        """Updates availability slots for a lawyer."""
        supabase_client = self.client
        loop = asyncio.get_running_loop()
        def _execute():
            return supabase_client.table("lawyers").update({"available_slots": slots}).eq("id", lawyer_id).execute()
        res = await loop.run_in_executor(None, _execute)
        return res.data[0] if res.data else {}
