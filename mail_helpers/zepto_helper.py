import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email.message import EmailMessage
from email import encoders
import time
import socket
import ssl as ssl_module
from configs import envs, logger


class ZeptoMail:
    def __init__(self):
        pass

    def send_email(subject, content, to_email, cc_email=None):
        attempt = 0
        max_retries=3
        while attempt < max_retries:
            try:
                msg = MIMEMultipart()
                msg['Subject'] = subject
                msg['From'] = envs.ZEPTO_FROM
                msg['To'] = ', '.join(to_email)
                if cc_email:
                    msg['Cc'] = ', '.join(cc_email)

                msg.attach(MIMEText(content, 'html'))

                context = ssl.create_default_context()
                with smtplib.SMTP(envs.ZEPTO_SERVER, envs.ZEPTO_PORT, timeout=60) as server:
                    server.starttls(context=context)
                    server.login(envs.ZEPTO_USERNAME, envs.ZEPTO_PASSWD_KEY)
                    server.send_message(msg)

                return {"status": "Success", "message": "Email sent successfully"}
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, ssl_module.SSLError, socket.timeout) as e:
                logger.warning(f"Transient error in zeptomail_send_email (attempt {attempt+1}): {str(e)}")
                attempt += 1
                time.sleep(2)
                continue
            except Exception as e:
                logger.error(f"Error in zeptomail_send_email: {str(e)}", stack_info=True)
                return {"status": "Failed", "message": str(e)}
        return {"status": "Failed", "message": "Max retries exceeded for zeptomail_send_email"}


    def send_email_with_attached(subject, content, to_email, document_buffer):
        attempt = 0
        max_retries=3
        while attempt < max_retries:
            try:
                msg = MIMEMultipart()
                msg['Subject'] = subject
                msg['From'] = envs.ZEPTO_FROM
                msg['To'] = ', '.join(to_email)

                msg.attach(MIMEText(content, 'html'))                        
                filename = f"{subject}.docx"
                part = MIMEBase("application", "octet-stream")
                part.set_payload(document_buffer.getvalue())
                encoders.encode_base64(part)
                part.add_header(
                    "Content-Disposition",
                    f"attachment; filename= {filename}",
                )
                msg.attach(part)

                context = ssl.create_default_context()
                with smtplib.SMTP(envs.ZEPTO_SERVER, envs.ZEPTO_PORT, timeout=60) as server:
                    server.starttls(context=context)
                    server.login(envs.ZEPTO_USERNAME, envs.ZEPTO_PASSWD_KEY)
                    server.send_message(msg)

                return {"status": "Success", "message": "Email sent successfully"}
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, ssl_module.SSLError, socket.timeout) as e:
                logger.warning(f"Transient error in zeptomail_send_email_with_attached (attempt {attempt+1}): {str(e)}")
                attempt += 1
                time.sleep(2)
                continue
            except Exception as e:
                logger.error(f"Error in zeptomail_send_email_with_attached: {str(e)}", stack_info=True)
                return {"status": "Failed", "message": str(e)}
        return {"status": "Failed", "message": "Max retries exceeded for zeptomail_send_email_with_attached"}


zepto_mail = ZeptoMail()